#!/bin/sh
# Records the host walkthrough: pictures, steps.json and walkthrough.mp4 in the given directory.
# Needs Xvfb, ffmpeg and ImageMagick's import; run `pnpm package:vscode` first.
set -eu
output=${1:-test-results/walkthrough}
display=${WARDEN_WALKTHROUGH_DISPLAY:-:97}
mkdir -p "$output"
output=$(cd "$output" && pwd)
Xvfb "$display" -screen 0 1440x900x24 >/dev/null 2>&1 &
xvfb=$!
trap 'kill "$xvfb" 2>/dev/null || true' EXIT
sleep 2
# Step times in steps.json are wall-clock; the recording's start turns them into positions in the video.
node -e 'process.stdout.write(JSON.stringify({ startedAt: Date.now() }) + "\n")' > "$output/recording.json"
ffmpeg -loglevel error -y -f x11grab -framerate 15 -video_size 1440x900 -i "$display" -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart "$output/walkthrough.mp4" &
recorder=$!
status=0
DISPLAY=$display WARDEN_VSCODE_WALKTHROUGH=$output WARDEN_VSCODE_WALKTHROUGH_PAUSE=${WARDEN_VSCODE_WALKTHROUGH_PAUSE:-3000} pnpm test:vscode || status=$?
kill -INT "$recorder"
wait "$recorder" 2>/dev/null || true
exit "$status"
