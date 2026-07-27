#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LilyPond(.ly) → PNG + PDF 렌더 스크립트

사용법:
  python scripts/render_lilypond.py path/to/score.ly
  python scripts/render_lilypond.py path/to/score.ly -o out/score

필요:
  - LilyPond 설치 (lilypond 명령이 PATH에 있어야 함)
    Windows 예: C:\\Program Files\\LilyPond\\usr\\bin\\lilypond.exe
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_lilypond(explicit: str | None = None) -> str:
    """lilypond 실행 파일 경로 찾기"""
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p)
        raise FileNotFoundError(f'지정한 lilypond 없음: {explicit}')

    env = os.environ.get('LILYPOND_PATH') or os.environ.get('LILYPOND')
    if env and Path(env).is_file():
        return env

    which = shutil.which('lilypond') or shutil.which('lilypond.exe')
    if which:
        return which

    # Windows 흔한 설치 경로
    candidates = [
        Path(r'C:\Program Files\LilyPond\usr\bin\lilypond.exe'),
        Path(r'C:\Program Files (x86)\LilyPond\usr\bin\lilypond.exe'),
        Path.home() / 'AppData/Local/Programs/LilyPond/usr/bin/lilypond.exe',
    ]
    for c in candidates:
        if c.is_file():
            return str(c)

    raise FileNotFoundError(
        'lilypond를 찾을 수 없습니다. 설치 후 PATH에 추가하거나 '
        '--lilypond / LILYPOND_PATH 로 경로를 지정하세요.\n'
        'https://lilypond.org/download.html'
    )


def run_lilypond(ly_path: Path, out_base: Path, lilypond: str) -> None:
    """PNG와 PDF를 각각 렌더"""
    out_base.parent.mkdir(parents=True, exist_ok=True)

    # PDF
    pdf_cmd = [
        lilypond,
        '--pdf',
        '-o',
        str(out_base),
        str(ly_path),
    ]
    print('[lilypond] PDF 렌더:', ' '.join(pdf_cmd))
    subprocess.check_call(pdf_cmd)

    # PNG (cairo 백엔드 우선, 실패 시 --png)
    png_cmds = [
        [
            lilypond,
            '-dbackend=cairo',
            '-fpng',
            '-dresolution=200',
            '-o',
            str(out_base),
            str(ly_path),
        ],
        [
            lilypond,
            '--png',
            '-dresolution=200',
            '-o',
            str(out_base),
            str(ly_path),
        ],
    ]

    last_err: Exception | None = None
    for cmd in png_cmds:
        try:
            print('[lilypond] PNG 렌더:', ' '.join(cmd))
            subprocess.check_call(cmd)
            last_err = None
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            print('[lilypond] PNG 시도 실패, 다음 옵션…', e)

    if last_err:
        raise RuntimeError(f'PNG 렌더 실패: {last_err}') from last_err


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description='LilyPond(.ly) 파일을 PNG·PDF로 렌더합니다.',
    )
    parser.add_argument('ly_file', help='입력 .ly 파일 경로')
    parser.add_argument(
        '-o',
        '--output',
        help='출력 파일 base 경로 (확장자 제외). 기본: 입력과 같은 이름',
    )
    parser.add_argument(
        '--lilypond',
        help='lilypond 실행 파일 경로 (선택)',
    )
    args = parser.parse_args(argv)

    ly_path = Path(args.ly_file).resolve()
    if not ly_path.is_file():
        print(f'입력 파일 없음: {ly_path}', file=sys.stderr)
        return 1
    if ly_path.suffix.lower() != '.ly':
        print('경고: 확장자가 .ly 가 아닙니다.', file=sys.stderr)

    out_base = Path(args.output).resolve() if args.output else ly_path.with_suffix('')
    try:
        lilypond = find_lilypond(args.lilypond)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 2

    print(f'[lilypond] binary = {lilypond}')
    print(f'[lilypond] input  = {ly_path}')
    print(f'[lilypond] output = {out_base}.{{pdf,png}}')

    try:
        run_lilypond(ly_path, out_base, lilypond)
    except subprocess.CalledProcessError as e:
        print(f'lilypond 실행 실패 (exit {e.returncode})', file=sys.stderr)
        return e.returncode or 1

    pdf = out_base.with_suffix('.pdf')
    # multi-page png: score.png / score-1.png 등
    pngs = list(out_base.parent.glob(out_base.name + '*.png'))
    print('--- 결과 ---')
    if pdf.is_file():
        print('PDF:', pdf)
    else:
        print('PDF: (생성 확인 필요)', pdf)
    for p in sorted(pngs):
        print('PNG:', p)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
