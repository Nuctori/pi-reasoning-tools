# -*- coding: utf-8 -*-
"""Diagnose git state of the monorepo and configure local identity + initial commit."""
import subprocess, os, shutil

REPO = r"D:\cs\pi-reasoning-tools"

def git(args, cwd=REPO):
    p = subprocess.run(["git", "-C", cwd] + args, capture_output=True, text=True, timeout=15)
    return p

print("== rev-parse ==")
p = git(["rev-parse", "--is-inside-work-tree"])
print("out:", repr(p.stdout.strip()), "code:", p.returncode)

print("\n== branch ==")
print(git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip() or git(["branch"]).stdout.strip())

print("\n== status short ==")
print(git(["status", "--porcelain=v1"]).stdout[:400])

print("\n== commits ==")
p = git(["log", "--oneline", "-3"])
print("out:", repr(p.stdout.strip()), "code:", p.returncode, "err:", p.stderr.strip()[:200])

# configure local identity + commit
print("\n== configure local identity ==")
git(["config", "user.name", "Nuctori"])
git(["config", "user.email", "nuctori@local"])
print("done")

print("\n== commit ==")
p = git(["add", "-A"])
print("add:", p.returncode)
p = git(["commit", "-m", "chore: initial commit — pi-repo-state + monorepo docs"])
print("commit:", p.returncode, p.stderr.strip()[:300])
print(git(["log", "--oneline", "-1"]).stdout.strip())
