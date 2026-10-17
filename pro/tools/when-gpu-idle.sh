#!/bin/sh
# Runs a command once the GPU is really idle: our lock free, no other compute process, and under 10%
# utilisation for 60 s straight. Then runs it holding the lock. For benchmarks on a shared machine.
set -eu
quiet=0
while :; do
  util=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -1)
  apps=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader | wc -l)
  if [ "$util" -lt 10 ] && [ "$apps" -eq 0 ] && flock -n /tmp/side-gpu.lock true; then quiet=$((quiet + 5)); else quiet=0; fi
  [ $quiet -ge 60 ] && break
  sleep 5
done
exec flock /tmp/side-gpu.lock "$@"
