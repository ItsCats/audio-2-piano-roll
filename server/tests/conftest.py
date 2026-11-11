"""Test settings: anonymous access, a throw-away DATA_DIR, no model download (the API tests mock SCNet)."""
import os
import sys
import tempfile

os.environ.setdefault("ALLOW_ANONYMOUS", "1")
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="p2v-test-"))
os.environ.setdefault("SCNET_AUTO_DOWNLOAD", "0")
os.environ.setdefault("ENABLE_YOUTUBE", "0")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
