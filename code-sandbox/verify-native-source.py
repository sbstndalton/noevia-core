#!/usr/bin/env python3
"""Verify a reviewed Git-export content digest before extracting verifier build input.

The digest binds paths, kinds, executable bits and contents, independent of tar
owner/time and gzip metadata. No archive member is extracted before validation.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import urllib.request

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
MAX_ENTRIES = 20000
DOMAIN = b'noevia-reviewed-git-export-v1\0'


def bounded(stream, limit):
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError('source size limit')
    return data


def path_ok(name):
    path = PurePosixPath(name)
    if (not name or len(name.encode('utf-8')) > 4096 or '\0' in name
            or path.is_absolute() or '..' in path.parts or str(path) != name):
        raise ValueError('noncanonical source path')
    return path


def inspect(data, prefix):
    path_ok(prefix)
    if '/' in prefix:
        raise ValueError('invalid source root')
    compressed = data[:2] == b'\x1f\x8b'
    if len(data) > (MAX_ARCHIVE if compressed else MAX_EXPANDED):
        raise ValueError('source size limit')
    if compressed:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            expanded = bounded(stream, MAX_EXPANDED)
    else:
        expanded = data
    if len(expanded) > MAX_EXPANDED:
        raise ValueError('expanded source size limit')
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for member in archive:
            if len(entries) >= MAX_ENTRIES:
                raise ValueError('source entry limit')
            full = member.name.rstrip('/') if member.isdir() else member.name
            full.encode('utf-8', errors='strict')
            if full == prefix and member.isdir():
                if entries.get('') is not None:
                    raise ValueError('duplicate source root')
                entries[''] = ('root', None)
                continue
            if not full.startswith(prefix + '/'):
                raise ValueError('unexpected source root')
            name = full[len(prefix) + 1:]
            path_ok(name)
            if name in entries:
                raise ValueError('duplicate source entry')
            if member.isfile():
                if not 0 <= member.size <= MAX_EXPANDED:
                    raise ValueError('source file size')
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError('missing source bytes')
                content = bounded(stream, member.size)
                if len(content) != member.size:
                    raise ValueError('truncated source file')
                record = ('file', member.mode & 0o111, len(content),
                          hashlib.sha256(content).hexdigest())
                entries[name] = (record, content)
            elif member.isdir():
                entries[name] = (('directory',), None)
            elif member.issym():
                # Git exports can carry relative links, never traversed during extraction.
                target = member.linkname
                target.encode('utf-8', errors='strict')
                if (not target or len(target.encode('utf-8')) > 4096
                        or '\0' in target or PurePosixPath(target).is_absolute()):
                    raise ValueError('unsafe source link')
                resolved = list(PurePosixPath(name).parent.parts)
                for part in target.split('/'):
                    if part == '..':
                        if not resolved:
                            raise ValueError('escaping source link')
                        resolved.pop()
                    elif part not in ('', '.'):
                        resolved.append(part)
                entries[name] = (('symlink', target), None)
            else:
                raise ValueError('unsupported source type')
    entries.pop('', None)
    if not entries:
        raise ValueError('empty source archive')
    for name in entries:
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.' and entries.get(str(parent), (None,))[0] != ('directory',):
                raise ValueError('missing or non-directory source parent')
    records = [[name, *entries[name][0]] for name in sorted(entries, key=lambda s: s.encode('utf-8'))]
    canonical = json.dumps(records, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    return hashlib.sha256(DOMAIN + canonical).hexdigest(), entries


def extract(data, prefix, expected, destination):
    if re.fullmatch('[0-9a-f]{64}', expected) is None:
        raise ValueError('invalid reviewed digest')
    digest, entries = inspect(data, prefix)
    if digest != expected:
        raise ValueError('source differs from reviewed Git export')
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    # A fresh destination and validated explicit directory ancestors prevent link traversal.
    for name in sorted(entries, key=lambda n: (n.count('/'), n)):
        record, content = entries[name]
        path = destination / name
        if record[0] == 'directory':
            path.mkdir(mode=0o755)
        elif record[0] == 'file':
            with path.open('xb') as stream:
                stream.write(content)
            path.chmod(0o755 if record[1] else 0o644)
    for name, (record, _) in entries.items():
        if record[0] == 'symlink':
            os.symlink(record[1], destination / name)
    return digest


def main(args):
    if len(args) == 3 and args[0] == 'digest':
        with open(args[1], 'rb') as stream:
            print(inspect(bounded(stream, MAX_EXPANDED), args[2])[0])
    elif len(args) == 5 and args[0] == 'extract':
        with open(args[1], 'rb') as stream:
            print(extract(bounded(stream, MAX_EXPANDED), args[2], args[3], args[4]))
    elif len(args) == 4 and args[0] == 'fetch':
        ref, expected, destination = args[1:]
        if re.fullmatch('[0-9a-f]{40}', ref) is None:
            raise ValueError('invalid reviewed ref')
        with urllib.request.urlopen(
                'https://codeload.github.com/sbstndalton/noevia-rs/tar.gz/' + ref,
                timeout=30) as stream:
            data = bounded(stream, MAX_ARCHIVE)
        print(extract(data, 'noevia-rs-' + ref, expected, destination))
    else:
        raise ValueError('invalid source verifier arguments')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, EOFError, tarfile.TarError):
        sys.exit('native verifier source does not match the reviewed export')
