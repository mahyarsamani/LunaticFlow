#!/usr/bin/env python3
"""lf: the agent's side of LunaticFlow sprints.

An agent plans its work as sprints (a graph: each path is serial, separate paths
run in parallel), does one sprint at a time, hands it over with `lf submit`, and
waits with `lf await` until the reviewer answers in the LunaticFlow extension.
A sprint is approved only by the reviewer, never by the agent.

State lives in <repo>/.lunaticflow/ (git-ignored through .git/info/exclude):
  plan.json, sprints/<id>.json, agents/<id>.json
The extension (src/flow/model.ts) reads and writes the same files.

Standard library only; Python 3.8 or newer.
"""
import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time

FLOW_DIR = ".lunaticflow"
SCHEMA_VERSION = 1


# ── helpers ──────────────────────────────────────────────────────────────────

def now():
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def die(msg, code=1):
    print(f"lf: {msg}", file=sys.stderr)
    sys.exit(code)


def git(root, *args, check=True):
    p = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
    if check and p.returncode != 0:
        die(f"git {' '.join(args)} failed: {p.stderr.strip()}")
    return p.stdout


def repo_root(start=None):
    p = subprocess.run(["git", "-C", start or os.getcwd(), "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        return None
    return p.stdout.strip()


def flow_dir(root):
    return os.path.join(root, FLOW_DIR)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, data):
    """Atomic write: the extension may read the file at any moment."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def ensure_init(root, title=None):
    d = flow_dir(root)
    os.makedirs(os.path.join(d, "sprints"), exist_ok=True)
    os.makedirs(os.path.join(d, "agents"), exist_ok=True)
    plan_path = os.path.join(d, "plan.json")
    if not os.path.exists(plan_path):
        write_json(plan_path, {"version": SCHEMA_VERSION, "title": title or os.path.basename(root),
                               "created": now(), "sprints": []})
    # Keep the state out of git without touching the repository's .gitignore.
    git_dir = git(root, "rev-parse", "--git-dir").strip()
    if not os.path.isabs(git_dir):
        git_dir = os.path.join(root, git_dir)
    exclude = os.path.join(git_dir, "info", "exclude")
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    try:
        with open(exclude) as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        lines = []
    if f"/{FLOW_DIR}/" not in lines:
        with open(exclude, "a") as f:
            f.write(f"\n# LunaticFlow sprint state\n/{FLOW_DIR}/\n")


def load_plan(root):
    plan = read_json(os.path.join(flow_dir(root), "plan.json"))
    if plan is None:
        die("no plan here; run `lf init` first")
    return plan


def save_plan(root, plan):
    write_json(os.path.join(flow_dir(root), "plan.json"), plan)


def sprint_path(root, sid):
    return os.path.join(flow_dir(root), "sprints", f"{sid}.json")


def load_state(root, sid):
    return read_json(sprint_path(root, sid)) or {
        "version": SCHEMA_VERSION, "id": sid, "status": "planned", "rounds": [], "threads": []}


def save_state(root, state):
    write_json(sprint_path(root, state["id"]), state)


def plan_sprint(plan, sid):
    for s in plan["sprints"]:
        if s["id"] == sid:
            return s
    die(f"no sprint {sid} in the plan")


def states(root, plan):
    return {s["id"]: load_state(root, s["id"]) for s in plan["sprints"]}


def ready(plan, st):
    approved = lambda i: st.get(i, {}).get("status") == "approved"
    return [s for s in plan["sprints"] if not approved(s["id"]) and all(approved(d) for d in s.get("deps", []))]


def clean_tree(root):
    out = git(root, "status", "--porcelain", "--untracked-files=no")
    return out.strip() == ""


# ── diff parsing (same rules as src/flow/diff.ts) ───────────────────────────

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def diff_args(base, head):
    return ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", base, head]


def hunk_key(path, lines):
    return hashlib.sha1((path + "\n" + "\n".join(lines)).encode()).hexdigest()[:12]


def _strip(p):
    if p == "/dev/null":
        return p
    p = re.sub(r"^[ab]/", "", p)
    return re.sub(r"\t.*$", "", p)


def parse_diff(text):
    files = []
    f = None
    h = None
    from_header = ""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    def finish():
        nonlocal h
        if f is not None and h is not None:
            h["key"] = hunk_key(f["path"], h["lines"])
            f["hunks"].append(h)
        h = None

    for line in lines:
        if line.startswith("diff --git "):
            finish()
            m = re.match(r"^diff --git a/(.*) b/(.*)$", line)
            f = {"path": m.group(2) if m else "", "oldPath": m.group(1) if m else "",
                 "status": "modified", "hunks": [], "header": [line]}
            files.append(f)
            from_header = ""
            continue
        if f is None:
            continue
        if h is not None:
            c = line[:1]
            if c in (" ", "+", "-", "\\") or line == "":
                h["lines"].append(" " if line == "" else line)
                continue
            finish()
        f["header"].append(line)
        if line.startswith("--- "):
            from_header = _strip(line[4:])
            continue
        if line.startswith("+++ "):
            to = _strip(line[4:])
            if to == "/dev/null":
                f["status"] = "deleted"
                f["path"] = from_header
                f["oldPath"] = from_header
            else:
                f["path"] = to
                f["oldPath"] = to if from_header == "/dev/null" else from_header
                if from_header == "/dev/null":
                    f["status"] = "added"
            continue
        if line.startswith("new file mode"):
            f["status"] = "added"
            continue
        if line.startswith("deleted file mode"):
            f["status"] = "deleted"
            continue
        if line.startswith("Binary files "):
            f["status"] = "binary"
            continue
        m = HUNK_RE.match(line)
        if m:
            f["header"].pop()  # the @@ line belongs to the hunk
            h = {"key": "", "header": line,
                 "oldStart": int(m.group(1)), "oldLines": 1 if m.group(2) is None else int(m.group(2)),
                 "newStart": int(m.group(3)), "newLines": 1 if m.group(4) is None else int(m.group(4)),
                 "lines": []}
    finish()
    for f in files:
        if not f["hunks"]:
            f["hunks"].append({"key": hunk_key(f["path"], [f"<{f['status']}>"]), "header": f"<{f['status']}>",
                               "oldStart": 0, "oldLines": 0, "newStart": 0, "newLines": 0, "lines": []})
    return files


def round_diff(root, rnd):
    return parse_diff(git(root, *diff_args(rnd["base"], rnd["head"])))


# ── commands ─────────────────────────────────────────────────────────────────

def cmd_init(a, root):
    ensure_init(root, a.title)
    print(f"LunaticFlow initialised in {os.path.join(root, FLOW_DIR)}")


def cmd_plan(a, root):
    ensure_init(root)
    plan = load_plan(root)
    if a.action == "show":
        st = states(root, plan)
        print(f"# {plan.get('title', '')}")
        for s in plan["sprints"]:
            deps = f" after {', '.join(s['deps'])}" if s.get("deps") else ""
            print(f"{s['id']:>8}  {st[s['id']]['status']:<10} {s['title']}{deps}")
        return
    if a.action == "title":
        plan["title"] = a.value
        save_plan(root, plan)
        return
    if a.action == "load":
        new = read_json(a.value)
        if new is None:
            die(f"cannot read {a.value}")
        sprints = new["sprints"] if isinstance(new, dict) else new
        for s in sprints:
            s.setdefault("deps", [])
        plan["sprints"] = sprints
        if isinstance(new, dict) and new.get("title"):
            plan["title"] = new["title"]
        save_plan(root, plan)
        print(f"plan has {len(sprints)} sprints")
        return
    if a.action == "add":
        if any(s["id"] == a.id for s in plan["sprints"]):
            die(f"sprint {a.id} exists")
        s = {"id": a.id, "title": a.title or a.id, "deps": [d for d in (a.deps or "").split(",") if d]}
        if a.goal:
            s["goal"] = a.goal
        if a.scope:
            s["scope"] = [p for p in a.scope.split(",") if p]
        if a.estimate:
            s["estimateHours"] = a.estimate
        if a.agent:
            s["agent"] = a.agent
        known = {x["id"] for x in plan["sprints"]}
        for d in s["deps"]:
            if d not in known:
                die(f"unknown dependency {d}")
        plan["sprints"].append(s)
        save_plan(root, plan)
        print(f"added {a.id}")


def cmd_next(a, root):
    plan = load_plan(root)
    st = states(root, plan)
    r = ready(plan, st)
    if not r:
        if all(st[s["id"]]["status"] == "approved" for s in plan["sprints"]):
            print("Every sprint in the plan is approved.")
        else:
            print("Nothing is ready: the remaining sprints wait on unapproved dependencies.")
        return
    for s in r:
        print(f"{s['id']}\t{st[s['id']]['status']}\t{s['title']}")


def cmd_start(a, root):
    plan = load_plan(root)
    s = plan_sprint(plan, a.sprint)
    st = states(root, plan)
    for d in s.get("deps", []):
        if st[d]["status"] != "approved":
            die(f"{a.sprint} depends on {d}, which is {st[d]['status']}")
    state = st[a.sprint]
    if state["status"] not in ("planned",):
        die(f"{a.sprint} is already {state['status']}")
    if not clean_tree(root):
        die("commit or stash your changes first: a sprint's base must be a clean commit")
    state["status"] = "working"
    state["base"] = git(root, "rev-parse", "HEAD").strip()
    state["branch"] = git(root, "rev-parse", "--abbrev-ref", "HEAD").strip()
    state["startedAt"] = now()
    if a.session:
        state["sessionId"] = a.session
    save_state(root, state)
    print(f"started {a.sprint} at {state['base'][:10]} on {state['branch']}")
    if s.get("goal"):
        print(f"goal: {s['goal']}")
    if s.get("scope"):
        print(f"scope: {', '.join(s['scope'])}")


def cmd_submit(a, root):
    state = load_state(root, a.sprint)
    if state["status"] not in ("working", "revising"):
        die(f"{a.sprint} is {state['status']}; only a working or revising sprint can be submitted")
    if not clean_tree(root):
        die("commit your changes first: the reviewer sees committed snapshots only")
    head = git(root, "rev-parse", "HEAD").strip()
    rounds = state["rounds"]
    base = rounds[-1]["head"] if rounds else state["base"]
    if head == base and not a.no_changes:
        die("no new commits since the last round; commit your changes, or pass --no-changes "
            "if this round only answers comments")
    rnd = {"n": len(rounds) + 1, "base": base, "head": head, "submittedAt": now()}
    if a.summary:
        rnd["summary"] = a.summary
    if a.tests:
        rnd["tests"] = a.tests
    rounds.append(rnd)
    state["status"] = "in_review"
    save_state(root, state)
    files = round_diff(root, rnd)
    n = sum(len(f["hunks"]) for f in files)
    print(f"{a.sprint} round {rnd['n']} is waiting for review: {len(files)} files, {n} changes.")
    print(f"Now run `lf await {a.sprint}` (in the background if you can) and do nothing else on this sprint.")


def report(root, state, rnd):
    """What the agent needs from a review: rejected changes and open threads."""
    rv = rnd["review"]
    out = []
    if rv["verdict"] == "approved":
        out.append(f"APPROVED: sprint {state['id']} is approved after round {rnd['n']}.")
        out.append("Run `lf next` and start the next ready sprint with `lf start <id>`.")
        return "\n".join(out)
    out.append(f"CHANGES REQUESTED on sprint {state['id']}, round {rnd['n']}.")
    files = {h["key"]: (f, h) for f in round_diff(root, rnd) for h in f["hunks"]}
    rejected = [(k, d) for k, d in rv["decisions"].items() if d["decision"] == "rejected"]
    if rejected:
        out.append("")
        out.append(f"## Rejected changes ({len(rejected)}): `lf revert-rejected {state['id']}` undoes them exactly")
        for k, d in rejected:
            f, h = files.get(k, (None, None))
            where = f"{d['path']} {h['header'] if h else ''}".strip()
            out.append(f"- {where}" + (f": {d['reason']}" if d.get("reason") else ""))
    threads = [t for t in state["threads"] if t["status"] == "open" and t.get("submitted")]
    if threads:
        out.append("")
        out.append(f"## Open threads ({len(threads)}): answer each with `lf reply {state['id']} <id> \"...\"`")
        for t in threads:
            out.append(f"- [{t['id']}] {t['path']}:{t['line']} (round {t['round']} head)")
            for m in t["messages"]:
                who = "reviewer" if m["author"] == "user" else "you"
                out.append(f"    {who}: {m['body']}")
    out.append("")
    out.append("Then: fix, commit, `lf submit {0} --summary \"...\"`, and `lf await {0}` again.".format(state["id"]))
    out.append("Do not change approved hunks unless a comment requires it; say so in the summary if you do.")
    return "\n".join(out)


def cmd_await(a, root):
    deadline = time.time() + a.timeout if a.timeout else None
    state = load_state(root, a.sprint)
    if state["status"] != "in_review" and not (state["rounds"] and state["rounds"][-1].get("review")):
        die(f"{a.sprint} is {state['status']}; submit it first")
    state["awaiting"] = {"pid": os.getpid(), "since": now()}
    save_state(root, state)
    try:
        while True:
            state = load_state(root, a.sprint)
            rnd = state["rounds"][-1]
            if rnd.get("review"):
                print(report(root, state, rnd))
                return
            if deadline and time.time() > deadline:
                print(f"No review yet for {a.sprint}; run `lf await {a.sprint}` again.")
                sys.exit(3)
            time.sleep(a.poll)
    finally:
        state = load_state(root, a.sprint)
        if (state.get("awaiting") or {}).get("pid") == os.getpid():
            state["awaiting"] = None
            save_state(root, state)


def cmd_show(a, root):
    state = load_state(root, a.sprint)
    if not state["rounds"]:
        die(f"{a.sprint} has no rounds")
    rnd = state["rounds"][-1]
    if not rnd.get("review"):
        print(f"{a.sprint} round {rnd['n']} is waiting for review.")
        return
    print(report(root, state, rnd))


def cmd_reply(a, root):
    state = load_state(root, a.sprint)
    for t in state["threads"]:
        if t["id"] == a.thread:
            t["messages"].append({"author": "agent", "body": a.text, "at": now(),
                                  "round": len(state["rounds"]) + 1})
            save_state(root, state)
            print(f"replied to {a.thread}")
            return
    die(f"no thread {a.thread} on {a.sprint}")


def cmd_revert_rejected(a, root):
    state = load_state(root, a.sprint)
    if not state["rounds"] or not state["rounds"][-1].get("review"):
        die("the last round has no review")
    rnd = state["rounds"][-1]
    rejected = {k for k, d in rnd["review"]["decisions"].items() if d["decision"] == "rejected"}
    if not rejected:
        print("no rejected changes")
        return
    if git(root, "rev-parse", "HEAD").strip() != rnd["head"]:
        die("HEAD moved since the reviewed round; revert the rejected changes by hand")
    patch = []
    found = set()
    for f in round_diff(root, rnd):
        hunks = [h for h in f["hunks"] if h["key"] in rejected]
        if not hunks:
            continue
        if any(not h["lines"] for h in hunks):
            die(f"{f['path']}: a binary or mode change cannot be reverted by patch; restore it with "
                f"`git checkout {rnd['base']} -- {f['path']}`")
        patch.extend(f["header"])
        for h in hunks:
            patch.append(h["header"])
            patch.extend(h["lines"])
            found.add(h["key"])
    missing = rejected - found
    if missing:
        die(f"rejected hunks not found in the round's diff: {', '.join(sorted(missing))}")
    text = "\n".join(patch) + "\n"
    p = subprocess.run(["git", "-C", root, "apply", "-R", "--recount", "-"], input=text, text=True,
                       capture_output=True)
    if p.returncode != 0:
        die(f"git apply -R failed: {p.stderr.strip()}")
    print(f"reverted {len(found)} rejected change(s); review with `git diff`, then commit")


def cmd_status(a, root):
    plan = load_plan(root)
    st = states(root, plan)
    if a.json:
        print(json.dumps({"plan": plan, "states": st}, indent=2))
        return
    cmd_plan(argparse.Namespace(action="show"), root)
    r = ready(plan, st)
    if r:
        print("ready: " + ", ".join(s["id"] for s in r))


# ── Claude Code hooks ────────────────────────────────────────────────────────

def _hook_root(payload):
    root = repo_root(payload.get("cwd") or os.getcwd())
    if not root or not os.path.isdir(flow_dir(root)):
        return None
    return root


def _agent_write(root, rec):
    path = os.path.join(flow_dir(root), "agents", f"{rec['id']}.json")
    old = read_json(path, {})
    old.update({k: v for k, v in rec.items() if v is not None})
    write_json(path, old)


def cmd_hook(a, root_unused):
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    root = _hook_root(payload)
    if root is None:
        return
    sid = payload.get("session_id")
    ev = a.event
    if ev in ("session-start", "session-end") and sid:
        rec = {"id": sid, "kind": "session", "sessionId": sid, "cwd": payload.get("cwd"),
               "transcriptPath": payload.get("transcript_path"), "updatedAt": now()}
        if ev == "session-start":
            rec["startedAt"] = now()
            rec["endedAt"] = None
        else:
            rec["endedAt"] = now()
        _agent_write(root, rec)
        return
    if ev in ("subagent-start", "subagent-stop") and sid:
        aid = payload.get("agent_id") or payload.get("subagent_id") or f"{sid}-sub"
        rec = {"id": aid, "kind": "subagent", "sessionId": aid, "parentSessionId": sid,
               "agentType": payload.get("agent_type") or payload.get("subagent_type"),
               "cwd": payload.get("cwd"), "transcriptPath": payload.get("agent_transcript_path"),
               "updatedAt": now()}
        if ev == "subagent-start":
            rec["startedAt"] = now()
        else:
            rec["endedAt"] = now()
        _agent_write(root, rec)
        return
    if ev == "post-bash" and sid:
        # Record which session runs a sprint: the agent ran `lf start <id>` or `lf submit <id>`.
        cmd = (payload.get("tool_input") or {}).get("command", "")
        for m in re.finditer(r"\blf(?:\.py)?\s+(?:-C\s+\S+\s+)?(?:start|submit)\s+([\w.-]+)", cmd):
            path = sprint_path(root, m.group(1))
            st = read_json(path)
            if st is not None and not st.get("sessionId"):
                st["sessionId"] = sid
                write_json(path, st)
        return
    if ev == "stop":
        if payload.get("stop_hook_active"):
            return
        plan = read_json(os.path.join(flow_dir(root), "plan.json"))
        if not plan:
            return
        mine = []
        for s in plan["sprints"]:
            st = load_state(root, s["id"])
            # Only the session that runs a sprint is held to it; other sessions in the repository are free.
            if not sid or st.get("sessionId") != sid:
                continue
            if st["status"] in ("working", "revising"):
                mine.append((s["id"], st["status"], "finish it, commit, then `lf submit {0}` and `lf await {0}`"))
            elif st["status"] == "in_review" and not st.get("awaiting"):
                mine.append((s["id"], "in_review", "run `lf await {0}` (in the background) to wait for the review"))
        if mine:
            reasons = "; ".join(f"sprint {i} is {stt}: " + todo.format(i) for i, stt, todo in mine)
            print(json.dumps({"decision": "block",
                              "reason": f"LunaticFlow: {reasons}. A sprint is done only when the reviewer approves it."}))


# ── main ─────────────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(prog="lf", description=__doc__.split("\n\n")[0])
    ap.add_argument("-C", dest="dir", help="run as if started in this directory")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="create .lunaticflow/ in this repository")
    p.add_argument("--title")

    p = sub.add_parser("plan", help="show or edit the plan")
    p.add_argument("action", choices=["show", "add", "load", "title"])
    p.add_argument("value", nargs="?", help="file for `load`, text for `title`")
    p.add_argument("--id")
    p.add_argument("--title", dest="title")
    p.add_argument("--goal")
    p.add_argument("--deps", help="comma-separated sprint ids")
    p.add_argument("--scope", help="comma-separated paths")
    p.add_argument("--estimate", type=float, help="agent hours")
    p.add_argument("--agent")

    sub.add_parser("next", help="list sprints whose dependencies are approved")
    sub.add_parser("status", help="plan and sprint states").add_argument("--json", action="store_true")

    p = sub.add_parser("start", help="start a ready sprint at the current clean HEAD")
    p.add_argument("sprint")
    p.add_argument("--session", help="Claude Code session id that owns the sprint")

    p = sub.add_parser("submit", help="hand the sprint's committed work to the reviewer")
    p.add_argument("sprint")
    p.add_argument("--summary")
    p.add_argument("--tests")
    p.add_argument("--no-changes", action="store_true", help="a round that only answers comments")

    p = sub.add_parser("await", help="block until the reviewer answers, then print the review")
    p.add_argument("sprint")
    p.add_argument("--timeout", type=float, default=0, help="seconds; 0 waits forever")
    p.add_argument("--poll", type=float, default=2.0)

    sub.add_parser("show", help="print the last review again").add_argument("sprint")

    p = sub.add_parser("reply", help="answer a reviewer's thread")
    p.add_argument("sprint")
    p.add_argument("thread")
    p.add_argument("text")

    sub.add_parser("revert-rejected", help="undo the rejected hunks of the last review").add_argument("sprint")

    p = sub.add_parser("hook", help="Claude Code hook entry point (reads the hook JSON on stdin)")
    p.add_argument("event", choices=["stop", "session-start", "session-end", "subagent-start", "subagent-stop",
                                     "post-bash"])

    a = ap.parse_args(argv)
    if a.cmd == "plan" and a.action == "add" and not a.id:
        die("plan add needs --id")
    if a.cmd == "hook":
        try:
            cmd_hook(a, None)
        except SystemExit:
            raise
        except Exception as e:  # a hook must never break the session
            print(f"lf hook: {e}", file=sys.stderr)
        return
    root = repo_root(a.dir)
    if root is None:
        die("not inside a git repository")
    {"init": cmd_init, "plan": cmd_plan, "next": cmd_next, "status": cmd_status, "start": cmd_start,
     "submit": cmd_submit, "await": cmd_await, "show": cmd_show, "reply": cmd_reply,
     "revert-rejected": cmd_revert_rejected}[a.cmd](a, root)


if __name__ == "__main__":
    main()
