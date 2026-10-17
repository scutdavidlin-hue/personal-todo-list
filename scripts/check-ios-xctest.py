#!/usr/bin/env python3
"""Require execution evidence for every checked-in XCTest method, not a green build."""
import json
from pathlib import Path
import re
import sys


def verify(source_directory, log_path):
    expected = set()
    for source in Path(source_directory).glob("*.swift"):
        expected.update(re.findall(r"\bfunc\s+(test\w+)\s*\(", source.read_text()))
    log = Path(log_path).read_text()
    passed = set(re.findall(r"Test Case '-\[[^\]]+ (test\w+)\]' passed", log))
    passed.update(re.findall(r"Test case '[^.']+\.(test\w+)\(\)' passed", log))
    counts = [int(value) for value in re.findall(r"Executed (\d+) tests?, with 0 failures", log)]
    missing = sorted(expected - passed)
    if not expected or missing or not any(count >= len(expected) for count in counts) or re.search(r"with [1-9]\d* failures?", log):
        raise ValueError("UNVERIFIED: every current XCTest method must execute and pass; missing=" + ",".join(missing))
    return {"swiftMethodsExpected": len(expected), "swiftMethodsPassed": len(expected), "missingMethods": []}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Usage: check-ios-xctest.py TEST_SOURCE_DIRECTORY XCTEST_LOG")
        print(json.dumps(verify(*sys.argv[1:]), sort_keys=True))
    except (ValueError, OSError) as error:
        sys.exit(str(error))
