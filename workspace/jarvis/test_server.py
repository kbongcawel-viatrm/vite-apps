#!/usr/bin/env python3
"""Unit tests for jarvis server."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent))

from server import (
    RateLimiter,
    cleanup_old_jobs,
    job_path,
    read_job,
    write_job,
)


class TestRateLimiter(unittest.TestCase):
    """Tests for RateLimiter class."""

    def test_rate_limiter_allows_within_limit(self):
        """Test that rate limiter allows requests within limit."""
        limiter = RateLimiter(max_per_min=10)
        for _ in range(10):
            self.assertTrue(limiter.allow())

    def test_rate_limiter_blocks_over_limit(self):
        """Test that rate limiter blocks requests over limit."""
        limiter = RateLimiter(max_per_min=2)
        self.assertTrue(limiter.allow())
        self.assertTrue(limiter.allow())
        self.assertFalse(limiter.allow())


class TestJobFunctions(unittest.TestCase):
    """Tests for job-related functions."""

    def setUp(self):
        """Set up test fixtures."""
        self.test_dir = tempfile.mkdtemp()
        self.jobs_dir = Path(self.test_dir) / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.patcher = patch('server.JOBS', self.jobs_dir)
        self.patcher.start()

    def tearDown(self):
        """Clean up test fixtures."""
        self.patcher.stop()
        import shutil
        shutil.rmtree(self.test_dir)

    def test_write_and_read_job(self):
        """Test write_job and read_job functions."""
        job = {"id": "test123", "name": "test", "status": 0}
        write_job(job)
        job_file = self.jobs_dir / f"{job['id']}.json"
        self.assertTrue(job_file.exists())
        result = read_job(job["id"])
        self.assertEqual(result, job)


if __name__ == "__main__":
    unittest.main()