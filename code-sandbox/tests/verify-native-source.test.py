"""Offline adversarial archive cases for the native verifier image source pin."""
import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('source', Path(__file__).parents[1] / 'verify-native-source.py')
source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source)


def archive(rows, stamp=1):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        for name, kind, payload, mode in rows:
            info = tarfile.TarInfo(name)
            info.mtime = stamp
            info.uid = stamp
            info.gid = stamp
            info.mode = mode
            if kind == 'directory':
                info.type = tarfile.DIRTYPE
            elif kind == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = payload
            elif kind == 'hardlink':
                info.type = tarfile.LNKTYPE
                info.linkname = payload
            else:
                info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload) if kind == 'file' else None)
    return output.getvalue()


ROWS = [('root', 'directory', None, 0o755),
        ('root/src', 'directory', None, 0o755),
        ('root/src/main', 'file', b'reviewed source', 0o644),
        ('root/build', 'file', b'#!/bin/sh\n', 0o755)]


class ReviewedSource(unittest.TestCase):
    def test_compression_owner_timestamp_do_not_change_content_pin(self):
        first = archive(ROWS)
        digest, _ = source.inspect(first, 'root')
        second = gzip.compress(archive(list(reversed(ROWS)), stamp=900), mtime=99)
        self.assertEqual(source.inspect(second, 'root')[0], digest)
        with tempfile.TemporaryDirectory() as parent:
            dest = Path(parent) / 'verified'
            self.assertEqual(source.extract(second, 'root', digest, dest), digest)
            self.assertEqual((dest / 'src/main').read_bytes(), b'reviewed source')
            self.assertEqual((dest / 'build').stat().st_mode & 0o7777, 0o755)
            self.assertEqual((dest / 'src/main').stat().st_mode & 0o7777, 0o644)
            with self.assertRaises(FileExistsError):
                source.extract(first, 'root', digest, dest)

    def test_contents_path_set_and_exec_mode_are_bound_before_any_write(self):
        digest, _ = source.inspect(archive(ROWS), 'root')
        variants = [ROWS[:-1], ROWS + [('root/extra', 'file', b'x', 0o644)],
                    ROWS[:-1] + [('root/build', 'file', b'changed', 0o755)],
                    ROWS[:-1] + [('root/build', 'file', ROWS[-1][2], 0o644)]]
        for rows in variants:
            with self.subTest(rows=rows), tempfile.TemporaryDirectory() as parent:
                dest = Path(parent) / 'untouched'
                with self.assertRaises(ValueError):
                    source.extract(archive(rows), 'root', digest, dest)
                self.assertFalse(dest.exists())

    def test_relative_links_are_preserved_but_never_traversed(self):
        rows = ROWS + [('root/link', 'symlink', 'src/main', 0o777)]
        data = archive(rows)
        digest, _ = source.inspect(data, 'root')
        with tempfile.TemporaryDirectory() as parent:
            dest = Path(parent) / 'verified'
            source.extract(data, 'root', digest, dest)
            self.assertTrue((dest / 'link').is_symlink())
            self.assertEqual((dest / 'link').read_bytes(), b'reviewed source')
        bad = rows + [('root/link/child', 'file', b'outside', 0o644)]
        with self.assertRaises(ValueError):
            source.inspect(archive(bad), 'root')

    def test_refuses_ambiguous_escaping_duplicate_and_unsupported_entries(self):
        bad = [ROWS + [ROWS[-1]], ROWS + [ROWS[0]],
               ROWS + [('other/file', 'file', b'x', 0o644)],
               ROWS + [('root/../escape', 'file', b'x', 0o644)],
               ROWS + [('root/src//bad', 'file', b'x', 0o644)],
               ROWS + [('root/absolute', 'symlink', '/tmp/out', 0o777)],
               ROWS + [('root/escaping', 'symlink', '../out', 0o777)],
               ROWS + [('root/hard', 'hardlink', 'root/src/main', 0o644)],
               [('root/absent/file', 'file', b'x', 0o644)]]
        for rows in bad:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                source.inspect(archive(rows), 'root')

    def test_compressed_bomb_and_input_size_are_bounded(self):
        old = source.MAX_ARCHIVE, source.MAX_EXPANDED, source.MAX_ENTRIES
        try:
            source.MAX_ARCHIVE = 2048
            source.MAX_EXPANDED = 4096
            with self.assertRaises(ValueError):
                source.inspect(b'x' * 4097, 'root')
            with self.assertRaises(ValueError):
                source.inspect(gzip.compress(b'\0' * 4097), 'root')
            source.MAX_ARCHIVE, source.MAX_EXPANDED = old[:2]
            source.MAX_ENTRIES = 2
            with self.assertRaises(ValueError):
                source.inspect(archive(ROWS), 'root')
        finally:
            source.MAX_ARCHIVE, source.MAX_EXPANDED, source.MAX_ENTRIES = old


if __name__ == '__main__':
    unittest.main()
