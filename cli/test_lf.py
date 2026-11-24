"""End-to-end test of the lf CLI on a scratch repository. Run: python3 cli/test_lf.py"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LF = [sys.executable, os.path.join(HERE, "lf.py")]
sys.path.insert(0, HERE)
import lf  # noqa: E402


def sh(cwd, *args, inp=None, check=True):
    p = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, input=inp)
    if check and p.returncode != 0:
        raise AssertionError(f"{args} failed ({p.returncode}): {p.stdout}{p.stderr}")
    return p


def read(root, path):
    with open(os.path.join(root, path)) as f:
        return f.read()


def write(root, path, text):
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text)


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        sh(self.root, "git", "init", "-q", "-b", "main")
        sh(self.root, "git", "config", "user.email", "t@t")
        sh(self.root, "git", "config", "user.name", "t")
        write(self.root, "src/a.c", "".join(f"line {i}\n" for i in range(1, 41)))
        sh(self.root, "git", "add", ".")
        sh(self.root, "git", "commit", "-qm", "base")

    def tearDown(self):
        self.tmp.cleanup()

    def lf(self, *args, inp=None, check=True):
        return sh(self.root, *LF, *args, inp=inp, check=check)

    def state(self, sid):
        with open(os.path.join(self.root, ".lunaticflow", "sprints", f"{sid}.json")) as f:
            return json.load(f)

    def review(self, sid, decide, threads=()):
        """Write a review the way the extension does."""
        st = self.state(sid)
        rnd = st["rounds"][-1]
        files = lf.round_diff(self.root, rnd)
        decisions = {}
        for f in files:
            for h in f["hunks"]:
                decisions[h["key"]] = {"path": f["path"], "decision": decide(f, h)}
        for t in threads:
            st["threads"].append(t)
        verdict = "approved" if all(d["decision"] == "approved" for d in decisions.values()) and not any(
            t["status"] == "open" for t in st["threads"]) else "changes"
        rnd["review"] = {"submittedAt": lf.now(), "decisions": decisions, "verdict": verdict}
        st["status"] = "approved" if verdict == "approved" else "revising"
        if verdict == "approved":
            st["approvedAt"] = lf.now()
        lf.write_json(os.path.join(self.root, ".lunaticflow", "sprints", f"{sid}.json"), st)
        return files

    def test_full_loop(self):
        self.lf("init", "--title", "demo")
        excl = read(self.root, ".git/info/exclude")
        self.assertIn("/.lunaticflow/", excl)
        self.lf("plan", "add", "--id", "s1", "--title", "first", "--scope", "src")
        self.lf("plan", "add", "--id", "s2", "--title", "second", "--deps", "s1")
        self.lf("plan", "add", "--id", "s3", "--title", "parallel", "--deps", "s1")
        self.assertIn("s1", self.lf("next").stdout)
        self.assertNotEqual(self.lf("start", "s2", check=False).returncode, 0)  # deps not approved

        self.lf("start", "s1")
        # The PostToolUse hook ties the sprint to the session that started it.
        self.lf("hook", "post-bash", inp=json.dumps({"session_id": "x", "cwd": self.root,
                                                     "tool_input": {"command": "cd src && lf start s1"}}))
        self.assertEqual(self.state("s1")["sessionId"], "x")
        other = self.lf("hook", "stop", inp=json.dumps({"session_id": "y", "cwd": self.root})).stdout
        self.assertEqual(other.strip(), "")  # another session in the repository is not held to s1
        mine = self.lf("hook", "stop", inp=json.dumps({"session_id": "x", "cwd": self.root})).stdout
        self.assertIn("is working", mine)
        text =read(self.root, "src/a.c").splitlines(keepends=True)
        text[4] = "line 5 changed\n"        # hunk 1
        text[30] = "line 31 drive-by\n"     # hunk 2, to be rejected
        write(self.root, "src/a.c", "".join(text))
        write(self.root, "src/new.c", "int x;\n")
        self.assertNotEqual(self.lf("submit", "s1", check=False).returncode, 0)  # dirty tree
        sh(self.root, "git", "add", ".")
        sh(self.root, "git", "commit", "-qm", "s1 work")
        out = self.lf("submit", "s1", "--summary", "did it").stdout
        self.assertIn("3 changes", out)

        # The agent waits in the background; the reviewer answers.
        waiter = subprocess.Popen([*LF, "await", "s1", "--poll", "0.2"], cwd=self.root,
                                  stdout=subprocess.PIPE, text=True)
        time.sleep(0.6)
        self.assertTrue(self.state("s1")["awaiting"])
        thread = {"id": "t1", "round": 1, "path": "src/new.c", "line": 1, "status": "open", "submitted": True,
                  "messages": [{"author": "user", "body": "make it static", "at": lf.now(), "round": 1}]}
        self.review("s1", lambda f, h: "rejected" if "drive-by" in "".join(h["lines"]) else "approved", [thread])
        out, _ = waiter.communicate(timeout=10)
        self.assertIn("CHANGES REQUESTED", out)
        self.assertIn("make it static", out)
        self.assertIsNone(self.state("s1")["awaiting"])

        # The agent reverts exactly the rejected hunk and answers the thread.
        self.lf("revert-rejected", "s1")
        now_text = read(self.root, "src/a.c")
        self.assertIn("line 5 changed", now_text)
        self.assertNotIn("drive-by", now_text)
        self.assertIn("line 31\n", now_text)
        write(self.root, "src/new.c", "static int x;\n")
        sh(self.root, "git", "commit", "-qam", "review fixes")
        self.lf("reply", "s1", "t1", "done")
        self.assertEqual(self.state("s1")["threads"][0]["messages"][-1]["round"], 2)
        self.lf("submit", "s1", "--summary", "round 2")
        st = self.state("s1")
        self.assertEqual(st["rounds"][1]["base"], st["rounds"][0]["head"])

        # The Stop hook blocks while the sprint is in review and nobody waits for it.
        hook = self.lf("hook", "stop", inp=json.dumps({"session_id": "x", "cwd": self.root})).stdout
        self.assertIn('"block"', hook)

        # Round 2: the reviewer resolves the thread and approves.
        st["threads"][0]["status"] = "resolved"
        lf.write_json(os.path.join(self.root, ".lunaticflow", "sprints", "s1.json"), st)
        self.review("s1", lambda f, h: "approved")
        self.assertIn("APPROVED", self.lf("show", "s1").stdout)
        nxt = self.lf("next").stdout
        self.assertIn("s2", nxt)
        self.assertIn("s3", nxt)
        hook = self.lf("hook", "stop", inp=json.dumps({"session_id": "x", "cwd": self.root})).stdout
        self.assertEqual(hook.strip(), "")

    def test_hooks_register_agents(self):
        self.lf("init")
        self.lf("hook", "session-start", inp=json.dumps({"session_id": "S", "cwd": self.root}))
        self.lf("hook", "subagent-start", inp=json.dumps({"session_id": "S", "agent_id": "A",
                                                          "agent_type": "Explore", "cwd": self.root}))
        self.lf("hook", "subagent-stop", inp=json.dumps({"session_id": "S", "agent_id": "A", "cwd": self.root}))
        with open(os.path.join(self.root, ".lunaticflow", "agents", "A.json")) as f:
            a = json.load(f)
        self.assertEqual(a["parentSessionId"], "S")
        self.assertEqual(a["agentType"], "Explore")
        self.assertIn("endedAt", a)
        # Outside a LunaticFlow repository the hooks do nothing and never fail.
        with tempfile.TemporaryDirectory() as d:
            p = sh(d, *LF, "hook", "stop", inp="not json")
            self.assertEqual(p.stdout, "")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--keys":
        # Print the hunk keys of a diff on stdin, for the cross-check against src/flow/diff.ts.
        for f in lf.parse_diff(sys.stdin.read()):
            for h in f["hunks"]:
                print(f["path"], f["status"], h["key"], h["newStart"], h["newLines"])
        sys.exit(0)
    unittest.main()
