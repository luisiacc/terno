import subprocess
import sys
import unittest
from run import process_identity, stop_owned


class SupervisorTest(unittest.TestCase):
    def test_joins_an_owned_child_that_ignores_term(self):
        child = subprocess.Popen(
            [sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready", flush=True); time.sleep(30)'],
            stdout=subprocess.PIPE, text=True,
        )
        identity = process_identity(child)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            stop_owned(child, identity, grace=0.1)
            self.assertIsNotNone(child.returncode)
        finally:
            if child.poll() is None:
                self.assertEqual(process_identity(child), identity)
                child.kill()
            child.wait(timeout=5)
            child.stdout.close()


if __name__ == '__main__':
    unittest.main()
