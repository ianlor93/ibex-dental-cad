import subprocess
import tempfile
import os
import io
import sys
from .config import BLENDER_PATH

class BlenderHandler:
    def __init__(self, logger):
        self.logger = logger
        # Verifica se bpy è disponibile nel processo corrente.
        # True quando il worker gira dentro Blender (blender -b -P worker.py).
        try:
            import bpy as _bpy  # noqa: F401
            self._bpy_available = True
        except ImportError:
            self._bpy_available = False

    def run_script(self, py_code):
        """Esegue codice Python arbitrario per operazioni Blender GN.

        Strategia a due livelli:
        1. Inline exec (no cold start) — se bpy è disponibile nel processo padre.
           Risparmia ~5-10s di startup Blender per ogni operazione Tier 2.
        2. Subprocess fallback — se bpy non è disponibile o se l'inline non è
           applicabile (salvaguardia per ambienti non-Blender).

        Il percorso subprocess rimane intatto e usa --python con tempfile
        (regola invariante §9: mai --python-expr, ARG_MAX silenzioso).
        """
        if self._bpy_available:
            return self._run_inline(py_code)
        return self._run_subprocess(py_code)

    # ──────────────────────────────────────────────────────────────────
    # PERCORSO 1: inline exec nel processo Blender padre
    # ──────────────────────────────────────────────────────────────────

    def _run_inline(self, py_code):
        """Esegue lo script GN inline via exec() nel processo Blender corrente.

        Prima di ogni esecuzione resetta bpy con read_homefile(use_empty=True)
        (~0.3s) invece di avviare un nuovo processo Blender (~5-10s cold start).
        Il costo dominante rimane open_mainfile(scene.blend) (~10-20s su FUSE).

        In caso di eccezione, tenta il reset dello stato bpy e ritorna False.
        Il finally garantisce sempre la pulizia di bpy.data.
        """
        import bpy  # disponibile: self._bpy_available == True

        stdout_buf = io.StringIO()
        old_stdout = sys.stdout

        try:
            # Reset bpy all'empty state prima di ogni operazione.
            # Più veloce (~0.3s) del cold start di un nuovo processo (~5-10s).
            bpy.ops.wm.read_homefile(use_empty=True)

            # Redirect stdout Python per catturare i print() [IBEX-ENGINE] dello script.
            # Il logging C-level di Blender va ancora al real stdout del container (docker logs).
            sys.stdout = stdout_buf

            exec(py_code, {  # noqa: S102
                'bpy': bpy,
                '__name__': '__main__',
                '__file__': '<ibex_inline>',
            })

        except Exception as e:
            sys.stdout = old_stdout
            self.logger(f"[BLENDER INLINE FAIL] {e}")
            # Tenta reset stato bpy dopo eccezione per non lasciare bpy.data corrotto
            try:
                bpy.ops.wm.read_homefile(use_empty=True)
            except Exception:
                pass
            return False

        finally:
            sys.stdout = old_stdout
            # Pulizia bpy.data dopo ogni operazione (successo o fallimento)
            try:
                bpy.ops.wm.read_homefile(use_empty=True)
            except Exception:
                pass

        # Parsing del log catturato
        captured = stdout_buf.getvalue()
        return self._parse_and_evaluate(captured)

    # ──────────────────────────────────────────────────────────────────
    # PERCORSO 2: subprocess (invariante §9 — mai --python-expr)
    # ──────────────────────────────────────────────────────────────────

    def _run_subprocess(self, py_code):
        """Esegue il codice Python in un processo Blender figlio separato.

        FIX CRITICO (invariante §9): usa --python con file temporaneo invece
        di --python-expr. --python-expr è soggetto al limite ARG_MAX di Linux
        (~2MB) e viene TRONCATO SILENZIOSAMENTE su catene multi-tool.
        """
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', suffix='.py', delete=False, dir='/tmp'
            ) as f:
                f.write(py_code)
                tmp_path = f.name

            res = subprocess.run(
                [BLENDER_PATH, "-b", "--python", tmp_path],
                capture_output=True,
                text=True,
                timeout=90
            )

            # Gestione Errori Stderr (filtra noise di Blender)
            if res.stderr:
                critical_lines = [
                    l.strip() for l in res.stderr.split('\n')
                    if l.strip() and ('Error' in l or 'CRITICAL' in l
                                      or 'Traceback' in l or 'Exception' in l)
                ]
                if critical_lines:
                    self.logger(f"[BLENDER STDERR] {'; '.join(critical_lines[:5])}")

            if res.returncode != 0:
                self.logger(f"[BLENDER FAIL] Exit Code {res.returncode}")
                last_lines = [l for l in res.stdout.split('\n') if l.strip()][-10:]
                if last_lines:
                    self.logger(f"[BLENDER TAIL] {' | '.join(last_lines)}")
                return False

            return self._parse_and_evaluate(res.stdout)

        except subprocess.TimeoutExpired:
            self.logger("[CRITICAL FAIL] Blender Timeout (>90s). Processo terminato.")
            return False

        except Exception as e:
            self.logger(f"[SYS ERR] Blender execution failed: {e}")
            return False

        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    # ──────────────────────────────────────────────────────────────────
    # Utility condivisa
    # ──────────────────────────────────────────────────────────────────

    def _parse_and_evaluate(self, stdout_text):
        """Parsa stdout alla ricerca di marker [IBEX-ENGINE].
        Ritorna False se ci sono [IBEX-ENGINE ERROR], True altrimenti.
        """
        if 'IBEX-ENGINE' in stdout_text:
            for line in stdout_text.split('\n'):
                if 'IBEX-ENGINE' in line:
                    self.logger(line.strip())

        engine_errors = [
            l.strip() for l in stdout_text.split('\n')
            if '[IBEX-ENGINE ERROR]' in l
        ]
        if engine_errors:
            self.logger(f"[BLENDER LOGIC FAIL] {len(engine_errors)} errori rilevati nello script")
            return False

        return True
