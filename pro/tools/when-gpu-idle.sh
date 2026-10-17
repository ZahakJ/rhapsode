#!/bin/sh
# Runs a command once the GPU is really idle: our lock free, no other compute process, and under 10%
# utilisation for 60 s straight. Then runs it holding the lock, and appends what else was on the GPU
# when it ended to $GPU_LOG (if set). For benchmarks on a shared machine.
set -eu
quiet=0
while :; do
  util=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -1)
  apps=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader | wc -l)
  if [ "$util" -lt 10 ] && [ "$apps" -eq 0 ] && flock -n /tmp/side-gpu.lock true; then quiet=$((quiet + 5)); else quiet=0; fi
  [ $quiet -ge 60 ] && break
  sleep 5
done
start=$(date -Is)
st=0
flock /tmp/side-gpu.lock "$@" || st=$?
if [ -n "${GPU_LOG:-}" ]; then
  others=$(nvidia-smi --query-compute-apps=process_name --format=csv,noheader | sed 's|.*/||' | tr '\n' ' ')
  echo "$start .. $(date -Is) idle at start; others at end: ${others:-none} :: $*" >> "$GPU_LOG"
fi
exit $st
