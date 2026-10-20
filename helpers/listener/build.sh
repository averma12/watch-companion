#!/bin/sh
# Builds the listener prototype as a command-line tool with its Info.plist (microphone usage
# string) embedded, then signs it ad hoc. Output: helpers/listener/build/listener
set -eu
cd "$(dirname "$0")"
mkdir -p build
swiftc -O -parse-as-library -target arm64-apple-macos14.0 \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
  -o build/listener Listener.swift
codesign --force --sign - --identifier com.averma12.watch-companion.listener build/listener
echo "built $(pwd)/build/listener"
