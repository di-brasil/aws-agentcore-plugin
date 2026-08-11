# docs

## verify-fixes-demo.mp4

A 22-second unedited screen capture of `scripts/verify-fixes-v2.sh` running to
completion. Real time, not sped up: a live run takes ~22.7s and the clip is 22.5s.

The script builds two servers — this branch, and `origin/main` in a throwaway git
worktree — then calls the same tool with the same arguments against each. Every
"before" line in the recording is live output from `main`, not a transcript. It
ends with `ALL 22 ASSERTIONS PASSED`.

Reproduce it yourself:

```bash
./scripts/verify-fixes-v2.sh
```

The recording was cropped to remove the desktop menu bar, re-encoded to 12fps
(it's static terminal text, so nothing is lost) and stripped of its silent audio
track. That took it from 2.1 MB to 972 KB.
