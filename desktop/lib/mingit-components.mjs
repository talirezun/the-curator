/**
 * mingit-components.mjs — every component inside the pinned MinGit, its
 * licence, and where its source is. The data behind THIRD-PARTY-NOTICES.txt
 * (desktop/lib/fetch-mingit.mjs) and behind the source files CI attaches to
 * each Windows release (scripts/publish-win-assets.js, job publish-windows).
 *
 * ── Where this list comes from ──────────────────────────────────────────────
 * The component lines are the ones Git for Windows publishes for this MinGit
 * as the release asset `package-versions-2.56.1-MinGit.txt` of
 * v2.56.1.windows.1 (2,134 bytes, SHA-256 in PACKAGE_VERSIONS_PROVENANCE,
 * matching GitHub's recorded digest). It was NOT read out of the MinGit zip
 * itself. That is why fetch-mingit.mjs compares the zip's own
 * etc/package-versions.txt with this table on every real build and REFUSES
 * the build when they differ in either direction: a component nobody has
 * classified never ships.
 *
 * ── How each licence was decided ────────────────────────────────────────────
 * From the package's own metadata at packages.msys2.org (its SPDX `licenses`
 * field) and the project's licence file at the tag of that version, read
 * 2026-11-20. Where MSYS2 says "custom" or gives a bare family name, `note`
 * says what the project's own file says.
 *
 *   copyleft    GPL, LGPL or MPL (any part): the exact source package is
 *               attached to the same GitHub release (COPYLEFT_SOURCES)
 *   permissive  MIT, BSD, Apache-2.0, zlib, curl, public domain …: the full
 *               licence text is in THIRD-PARTY-NOTICES.txt, with the address
 *               of its source package
 *
 * ── The source packages ─────────────────────────────────────────────────────
 * makepkg's own `.src.tar.*` for the exact package version: the PKGBUILD,
 * every patch, and the upstream source. Packages Git for Windows builds
 * itself come from its releases (sha256 pinned: GitHub records a digest);
 * the rest from repo.msys2.org/{msys,mingw}/sources/ (no published digest,
 * so the exact byte size is pinned and CI checks the archive's structure:
 * a tar in which every entry sits under `<pkgbase>/` and `<pkgbase>/PKGBUILD`
 * exists). `asset` is the name it is attached under: the upstream file name,
 * with `~` (an MSYS2 epoch marker that GitHub rewrites in asset names) as `_`.
 *
 * Electron-free and src-free, like every module in desktop/lib.
 */

export const PACKAGE_VERSIONS_PROVENANCE = Object.freeze({
  asset: 'package-versions-2.56.1-MinGit.txt',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/package-versions-2.56.1-MinGit.txt',
  size: 2134,
  sha256: '2d03bb928c4589af6ef057e9d7b41fd3057428eefd671212e59df10ef4bc03c3',
});

const MSYS = 'https://repo.msys2.org/msys/sources/';
const MINGW = 'https://repo.msys2.org/mingw/sources/';
const GFW_PACMAN = 'https://github.com/git-for-windows/pacman-repo/releases/download/';

/** The full licence texts (desktop/licences/mingit/<file>), each pinned. */
export const LICENCE_TEXTS = Object.freeze({
  'GPL-2.0':           { file: 'spdx-GPL-2.0-only.txt', sha256: 'aaf135472f81c5b4a0dca9367e5bb5e9750032b5bebe5442b36e4c0a47430df3', title: 'GNU General Public License, version 2', from: 'https://github.com/spdx/license-list-data/blob/v3.29.0/text/GPL-2.0-only.txt' },
  'GPL-3.0':           { file: 'spdx-GPL-3.0-or-later.txt', sha256: 'fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0', title: 'GNU General Public License, version 3', from: 'https://github.com/spdx/license-list-data/blob/v3.29.0/text/GPL-3.0-or-later.txt' },
  'LGPL-2.1':          { file: 'spdx-LGPL-2.1-or-later.txt', sha256: '5749785c8bdefafcb5d798270ed0a967036fe2ca63dcedade1627565dfef81d2', title: 'GNU Lesser General Public License, version 2.1', from: 'https://github.com/spdx/license-list-data/blob/v3.29.0/text/LGPL-2.1-or-later.txt' },
  'LGPL-3.0':          { file: 'spdx-LGPL-3.0-or-later.txt', sha256: '996af0513df21f7496288951c41428a03c174e9e4a9d63665c57d670f845ccb1', title: 'GNU Lesser General Public License, version 3', from: 'https://github.com/spdx/license-list-data/blob/v3.29.0/text/LGPL-3.0-or-later.txt' },
  'MPL-2.0':           { file: 'spdx-MPL-2.0.txt', sha256: '66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172', title: 'Mozilla Public License, version 2.0', from: 'https://github.com/spdx/license-list-data/blob/v3.29.0/text/MPL-2.0.txt' },
  'GCC-exception-3.1': { file: 'spdx-GCC-exception-3.1.txt', sha256: '7103d4f7f7e2f8ce10d282a05e0689637f8d6d9ef7b399d808d1da313e69b960', title: 'GCC Runtime Library Exception, version 3.1', from: 'https://github.com/spdx/license-list-data/blob/v3.29.0/text/GCC-exception-3.1.txt' },
  'dash':              { file: 'dash.txt', sha256: '254a7894923ff62e69184a991dcbccae97edee58a1105e8efbe78caf10595d72', title: 'dash: BSD-3-Clause (with GPL-2.0-or-later parts)', from: 'https://git.kernel.org/pub/scm/utils/dash/dash.git/tree/COPYING' },
  'heimdal':           { file: 'heimdal.txt', sha256: '0c4b07bf5b98f7a1d01f8e60722d6c6747ef052c2aa6d2043daf690d4e1b0a7f', title: 'Heimdal (BSD-3-Clause)', from: 'https://github.com/heimdal/heimdal/blob/heimdal-7.8.0/LICENSE' },
  'libcbor':           { file: 'libcbor.txt', sha256: '6a5e182d758db66ecad6e6fa304dc637d4d2585bafceb5003c86e8dc9f6344ff', title: 'libcbor (MIT)', from: 'https://github.com/PJK/libcbor/blob/v0.11.0/LICENSE.md' },
  'libfido2':          { file: 'libfido2.txt', sha256: 'e8946152897134a9e9205b0db0659dd77c279de683d7cc64465629a12d1abfd8', title: 'libfido2 (BSD-2-Clause)', from: 'https://github.com/Yubico/libfido2/blob/1.15.0/LICENSE' },
  'openssl':           { file: 'openssl.txt', sha256: '7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a', title: 'OpenSSL (Apache License 2.0)', from: 'https://github.com/openssl/openssl/blob/openssl-3.5.9/LICENSE.txt' },
  'pcre1':             { file: 'pcre1.txt', sha256: '51b3dea44f63338b84b9c97b3d793826a8397309068cf9379a423216ab8ea5b2', title: 'PCRE 8 (BSD-3-Clause)', from: 'pcre-8.45/LICENCE (the 8.45 release; read from the DragonFly BSD source tree, grok.dragonflybsd.org)' },
  'pcre2':             { file: 'pcre2.txt', sha256: '197d8a73ffee0d6b09adba2f9c677b5f5aede24edf89258a68e48248d010d811', title: 'PCRE2 (BSD-3-Clause with the PCRE2 exception)', from: 'https://github.com/PCRE2Project/pcre2/blob/pcre2-10.49/LICENCE.md' },
  'sqlite':            { file: 'sqlite.txt', sha256: 'ee6af51062b30d532991face5164136ae6f84e265ecf8abe89dc69dac45ca1e7', title: 'SQLite (public domain)', from: 'https://github.com/sqlite/sqlite/blob/version-3.54.0/LICENSE.md' },
  'brotli':            { file: 'brotli.txt', sha256: '3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94', title: 'Brotli (MIT)', from: 'https://github.com/google/brotli/blob/v1.2.1/LICENSE' },
  'curl':              { file: 'curl.txt', sha256: '82f2f4427d6545ee5aaac4f0b80428da6cc8ba41c2cf5da3a03680ec327b9681', title: 'curl (the curl licence)', from: 'https://github.com/curl/curl/blob/curl-8_23_0/COPYING' },
  'expat':             { file: 'expat.txt', sha256: '31b15de82aa19a845156169a17a5488bf597e561b2c318d159ed583139b25e87', title: 'Expat (MIT)', from: 'https://github.com/libexpat/libexpat/blob/R_2_9_0/expat/COPYING' },
  'gcm':               { file: 'git-credential-manager.txt', sha256: 'b47f1a8a744ecdc7a3da35804f88552805d33f51a726b87a2105acdfae406b07', title: 'Git Credential Manager (MIT)', from: 'https://github.com/git-ecosystem/git-credential-manager/blob/v2.9.1/LICENSE' },
  'libffi':            { file: 'libffi.txt', sha256: '17b64dc60f3b6897a60f971e288b973f655c2edcdf08b25f3c3dd5549857881c', title: 'libffi (MIT)', from: 'https://github.com/libffi/libffi/blob/v3.8.0/LICENSE' },
  'libpsl':            { file: 'libpsl.txt', sha256: '322392e6001b2b3b0fca705dc9f11f26e12441188ecde50eb1d22909980b2925', title: 'libpsl (MIT)', from: 'https://github.com/rockdaboot/libpsl/blob/0.21.5/COPYING' },
  'libssh2':           { file: 'libssh2.txt', sha256: 'f7f9633cf9ff2f1333f3d7ce46973a8716a4d2a2815ad56f30d437d5fea7bafe', title: 'libssh2 (BSD-3-Clause)', from: 'https://github.com/libssh2/libssh2/blob/libssh2-1.11.1/COPYING' },
  'winpthreads':       { file: 'winpthreads.txt', sha256: '63263614cdd29f2f93cba85e992f041b31f9fc7b4033692f31269489a8a1b177', title: 'mingw-w64 winpthreads (MIT and BSD-3-Clause)', from: 'https://github.com/mingw-w64/mingw-w64/blob/7ce22f663/mingw-w64-libraries/winpthreads/COPYING' },
  'nghttp2':           { file: 'nghttp2.txt', sha256: '6b94f3abc1aabd0c72a7c7d92a77f79dda7c8a0cb3df839a97890b4116a2de2a', title: 'nghttp2 (MIT)', from: 'https://github.com/nghttp2/nghttp2/blob/v1.70.0/COPYING' },
  'zlib':              { file: 'zlib.txt', sha256: 'e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2', title: 'zlib (the zlib licence)', from: 'https://github.com/madler/zlib/blob/v1.3.2/LICENSE' },
  'zstd':              { file: 'zstd.txt', sha256: '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8', title: 'Zstandard (BSD-3-Clause)', from: 'https://github.com/facebook/zstd/blob/v1.5.7/LICENSE' },
  'ncurses':           { file: 'ncurses.txt', sha256: '708999f95527e1ffa670c6fce288c6c600cb477dd04afcc1171422b3dd4ee226', title: 'ncurses (X11-style MIT)', from: 'https://github.com/ThomasDickey/ncurses-snapshots/blob/v6_6/COPYING' },
  'openssh':           { file: 'openssh.txt', sha256: '5bb5b160726ef5756e4f32fe95b35249c294962419650f48d05134b486d27ccb', title: 'OpenSSH (BSD-style; the OpenSSH LICENCE)', from: 'https://github.com/openssh/openssh-portable/blob/V_10_6_P1/LICENCE' },
  'msys2-filesystem':  { file: 'msys2-filesystem.txt', sha256: 'e08ac31ef517ea449b7f402ab7940c750127c1de0566458d8e80635be9fa4055', title: 'MSYS2 packaging (BSD-3-Clause)', from: 'https://github.com/msys2/MSYS2-packages/blob/master/LICENSE' },
});

/**
 * The source packages CI attaches to each Windows release, one per copyleft
 * package base. `sha256` is null where the host publishes no digest; `size`
 * is always exact.
 */
const src = (base, ver, host, size, sha256 = null, ext = 'zst', url = null) => {
  const name = `${base}-${ver}.src.tar.${ext}`;
  return Object.freeze({
    key: `${base}-${ver}`,
    pkgbase: base,
    upstreamName: name,
    asset: name.replace(/~/g, '_'),
    url: url || `${host}${encodeURIComponent(name).replace(/%7E/gi, '~')}`,
    size,
    sha256,
  });
};
export const COPYLEFT_SOURCES = Object.freeze([
  src('gawk', '5.4.1-1', MSYS, 6693723),
  src('coreutils', '8.32-5', MSYS, 5561991),
  src('diffutils', '3.12-1', MSYS, 1941123),
  src('findutils', '4.11.0-2', MSYS, 2454027),
  src('gcc', '16.2.0-1', MSYS, 107239619),
  src('gmp', '6.3.0-2', MSYS, 2096699),
  src('grep', '1~3.0-7', MSYS, 1378706),
  src('libiconv', '1.19-1', MSYS, 5133707),
  src('gettext', '0.22.5-1', MSYS, 21732949),
  src('readline', '8.3.006-1', MSYS, 3357587),
  src('libxcrypt', '4.5.2-1', MSYS, 672527),
  src('mpfr', '4.2.2-1', MSYS, 1507563),
  src('msys2-runtime', '3.6.10-4', null, 147910549, '3dae788aee6bf5244f124aa7e0a04328e6585d92ed1826bb510f23aefbc40a1e', 'gz',
    `${GFW_PACMAN}2026-09-28T10-53-27.205004700Z/msys2-runtime-3.6.10-4.src.tar.gz`),
  src('sed', '4.9-1', MSYS, 1399712),
  src('bash', '5.3.015-2', null, 11373772, '817a480aa08f0f112af9496a9335d3a48f4c479ef5e1b1740df6dcc76670d94a', 'gz',
    `${GFW_PACMAN}2026-08-20T13-55-07.365148200Z/bash-5.3.015-2.src.tar.gz`),
  src('dash', '0.5.13.5-1', MSYS, 262843),
  src('rebase', '4.5.0-5', MSYS, 341196),
  src('mingw-w64-ca-certificates', '20260816-3', MINGW, 282907),
  src('mingw-w64-gcc', '16.2.0-6', MINGW, 107229138),
  src('mingw-w64-docx2txt-rs', '0.2.0-1', MINGW, 53662),
  src('mingw-w64-gettext', '1.0-1', MINGW, 10267655),
  src('mingw-w64-git', '2.56.1.1-1', null, 13074447, '2a0769d21e3e3cec9216ddca920fe7d7efe274e7d1c14882003a2ce7d674c7b4', 'gz',
    'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/mingw-w64-git-2.56.1.1-1.src.tar.gz'),
  src('mingw-w64-git-extra', '1.1.715.85f886165-1', null, 54126, 'a17b18ebe09ba357c798f8963497fd8086e4cc8a5f889e9a351a614d038cf331', 'gz',
    `${GFW_PACMAN}2026-09-10T22-57-20.747747200Z/mingw-w64-git-extra-1.1.715.85f886165-1.src.tar.gz`),
  src('mingw-w64-libiconv', '1.19-1', MINGW, 5131029),
  src('mingw-w64-libidn2', '2.3.8-4', MINGW, 2147337),
  src('mingw-w64-libpsl', '0.21.5-3', MINGW, 6829368),
  src('mingw-w64-libtasn1', '4.21.0-1', MINGW, 1732161),
  src('mingw-w64-libunistring', '1.4.2-1', MINGW, 4770800),
]);

const M = (base, ver, ext = 'zst') => `${MINGW}${base}-${ver}.src.tar.${ext}`;
const S = (base, ver, ext = 'zst') => `${MSYS}${base}-${ver}.src.tar.${ext}`;
const G = (rel, file) => `${GFW_PACMAN}${rel}/${file}`;

/**
 * One row per component line of etc/package-versions.txt (name + version,
 * exactly). `source` is the key of a COPYLEFT_SOURCES entry (attached) or,
 * for a permissive component, the address of its source package.
 */
const C = (name, version, kind, licence, texts, homepage, source, note = null) =>
  Object.freeze({ name, version, kind, licence, texts: Object.freeze(texts), homepage, source, note });
const GCC_RT = 'GPL-3.0-or-later WITH GCC-exception-3.1';
export const MINGIT_COMPONENTS = Object.freeze([
  C('gawk', '5.4.1-1', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/gawk/', 'gawk-5.4.1-1'),
  C('coreutils', '8.32-5', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/coreutils/', 'coreutils-8.32-5'),
  C('diffutils', '3.12-1', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/diffutils/', 'diffutils-3.12-1'),
  C('findutils', '4.11.0-2', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/findutils/', 'findutils-4.11.0-2'),
  C('gcc-libs', '16.2.0-1', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'gcc-16.2.0-1'),
  C('gmp', '6.3.0-2', 'copyleft', 'LGPL-3.0-or-later', ['LGPL-3.0', 'GPL-3.0'], 'https://gmplib.org/', 'gmp-6.3.0-2'),
  C('grep', '1~3.0-7', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/grep/', 'grep-1~3.0-7'),
  C('heimdal-libs', '7.8.0-5', 'permissive', 'BSD-3-Clause', ['heimdal'], 'https://www.h5l.org/', G('2025-02-17T20-04-24.273150900Z', 'heimdal-7.8.0-5.src.tar.gz'), 'MSYS2 labels it LicenseRef-Heimdal; its LICENSE is the 3-clause BSD text'),
  C('libcbor', '0.11.0-1', 'permissive', 'MIT', ['libcbor'], 'https://github.com/PJK/libcbor', G('2024-02-05T16-30-39.000Z', 'libcbor-0.11.0-1.src.tar.gz')),
  C('libfido2', '1.15.0-1', 'permissive', 'BSD-2-Clause', ['libfido2'], 'https://developers.yubico.com/libfido2/', G('2024-06-14T09-31-36.000Z', 'libfido2-1.15.0-1.src.tar.gz')),
  C('libiconv', '1.19-1', 'copyleft', 'LGPL-2.1-or-later', ['LGPL-2.1'], 'https://www.gnu.org/software/libiconv/', 'libiconv-1.19-1', 'the library; its programs are GPL-3.0-or-later'),
  C('libintl', '0.22.5-1', 'copyleft', 'LGPL-2.1-or-later', ['LGPL-2.1'], 'https://www.gnu.org/software/gettext/', 'gettext-0.22.5-1', 'part of gettext'),
  C('libopenssl', '3.5.9-1', 'permissive', 'Apache-2.0', ['openssl'], 'https://openssl-library.org/', G('2026-09-30T08-56-50.408104900Z', 'openssl-3.5.9-1.src.tar.gz')),
  C('libpcre', '8.45-5', 'permissive', 'BSD-3-Clause', ['pcre1'], 'https://www.pcre.org/', S('pcre', '8.45-5')),
  C('libreadline', '8.3.006-1', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://tiswww.case.edu/php/chet/readline/rltop.html', 'readline-8.3.006-1'),
  C('libsqlite', '3.54.0-1', 'permissive', 'blessing (public domain)', ['sqlite'], 'https://www.sqlite.org/', S('sqlite', '3.54.0-1')),
  C('libxcrypt', '4.5.2-1', 'copyleft', 'LGPL-2.1-or-later', ['LGPL-2.1'], 'https://github.com/besser82/libxcrypt/', 'libxcrypt-4.5.2-1'),
  C('mingw-w64-ucrt-x86_64-brotli', '1.2.1-1', 'permissive', 'MIT', ['brotli'], 'https://github.com/google/brotli', M('mingw-w64-brotli', '1.2.1-1')),
  C('mingw-w64-ucrt-x86_64-ca-certificates', '20260816-3', 'copyleft', 'MPL-2.0 AND GPL', ['MPL-2.0', 'GPL-2.0', 'GPL-3.0'], 'https://www.mozilla.org/en-US/about/governance/policies/security-group/certs/', 'mingw-w64-ca-certificates-20260816-3', 'the certificate data is MPL-2.0; MSYS2 labels its packaging "GPL" without a version'),
  C('mingw-w64-ucrt-x86_64-cc-libs', '16.2.0-6', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-curl-winssl', '8.23.0-1', 'permissive', 'curl', ['curl'], 'https://curl.se/', G('2026-10-15T16-10-28.300057100Z', 'mingw-w64-curl-8.23.0-1.src.tar.gz')),
  C('mingw-w64-ucrt-x86_64-curl-openssl-alternate', '8.23.0-1', 'permissive', 'curl', ['curl'], 'https://curl.se/', G('2026-10-15T16-10-28.300057100Z', 'mingw-w64-curl-8.23.0-1.src.tar.gz')),
  C('mingw-w64-ucrt-x86_64-docx2txt-rs', '0.2.0-1', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://github.com/dscho/docx2txt-rs', 'mingw-w64-docx2txt-rs-0.2.0-1'),
  C('mingw-w64-ucrt-x86_64-expat', '2.9.0-1', 'permissive', 'MIT', ['expat'], 'https://libexpat.github.io/', M('mingw-w64-expat', '2.9.0-1')),
  C('mingw-w64-ucrt-x86_64-gcc-libs', '16.2.0-6', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-gettext-runtime', '1.0-1', 'copyleft', 'GPL-3.0-or-later AND LGPL-2.1-or-later', ['GPL-3.0', 'LGPL-2.1'], 'https://www.gnu.org/software/gettext/', 'mingw-w64-gettext-1.0-1'),
  C('mingw-w64-ucrt-x86_64-git', '2.56.1.1-1', 'copyleft', 'GPL-2.0-only', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1'),
  C('mingw-w64-ucrt-x86_64-git-credential-manager', '2.9.1-1', 'permissive', 'MIT', ['gcm'], 'https://github.com/git-ecosystem/git-credential-manager', G('2026-07-14T20-22-11.997190100Z', 'mingw-w64-git-credential-manager-2.9.1-1.src.tar.gz')),
  C('mingw-w64-ucrt-x86_64-git-credential-wincred', '2.56.1.1-1', 'copyleft', 'GPL-2.0-only', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-git-extra', '1.1.715.85f886165-1', 'copyleft', 'GPL-2.0', ['GPL-2.0'], 'https://github.com/git-for-windows/build-extra', 'mingw-w64-git-extra-1.1.715.85f886165-1'),
  C('mingw-w64-ucrt-x86_64-git-for-windows-addons', '2.56.1.1-1', 'copyleft', 'GPL-2.0-only', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-git-gui', '2.56.1.1-1', 'copyleft', 'GPL-2.0-or-later', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-git-perl', '2.56.1.1-1', 'copyleft', 'GPL-2.0-only', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-git-send-email', '2.56.1.1-1', 'copyleft', 'GPL-2.0-only', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-git-subtree', '2.56.1.1-1', 'copyleft', 'GPL-2.0-only', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-gitk', '2.56.1.1-1', 'copyleft', 'GPL-2.0-or-later', ['GPL-2.0'], 'https://gitforwindows.org/', 'mingw-w64-git-2.56.1.1-1', 'built from the git source'),
  C('mingw-w64-ucrt-x86_64-libatomic', '16.2.0-6', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-libffi', '3.8.0-1', 'permissive', 'MIT', ['libffi'], 'https://sourceware.org/libffi/', M('mingw-w64-libffi', '3.8.0-1')),
  C('mingw-w64-ucrt-x86_64-libgcc', '16.2.0-6', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-libgomp', '16.2.0-6', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-libiconv', '1.19-1', 'copyleft', 'LGPL-2.1-or-later', ['LGPL-2.1'], 'https://www.gnu.org/software/libiconv/', 'mingw-w64-libiconv-1.19-1', 'the library; its programs are GPL-3.0-or-later'),
  C('mingw-w64-ucrt-x86_64-libidn2', '2.3.8-4', 'copyleft', 'GPL-2.0-or-later OR LGPL-3.0-or-later', ['GPL-2.0', 'LGPL-3.0'], 'https://www.gnu.org/software/libidn/#libidn2', 'mingw-w64-libidn2-2.3.8-4'),
  C('mingw-w64-ucrt-x86_64-libpsl', '0.21.5-3', 'copyleft', 'MIT AND MPL-2.0', ['libpsl', 'MPL-2.0'], 'https://rockdaboot.github.io/libpsl/', 'mingw-w64-libpsl-0.21.5-3', 'the code is MIT; the Public Suffix List data built into it is MPL-2.0, so its source is attached too'),
  C('mingw-w64-ucrt-x86_64-libquadmath', '16.2.0-6', 'copyleft', 'LGPL-2.1-or-later', ['LGPL-2.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-libssh2-wincng', '1.11.1-2', 'permissive', 'BSD-3-Clause', ['libssh2'], 'https://libssh2.org/', M('mingw-w64-libssh2', '1.11.1-2')),
  C('mingw-w64-ucrt-x86_64-libstdc++', '16.2.0-6', 'copyleft', GCC_RT, ['GPL-3.0', 'GCC-exception-3.1'], 'https://gcc.gnu.org/', 'mingw-w64-gcc-16.2.0-6'),
  C('mingw-w64-ucrt-x86_64-libtasn1', '4.21.0-1', 'copyleft', 'GPL-3.0-or-later AND LGPL-2.1-or-later', ['GPL-3.0', 'LGPL-2.1'], 'https://www.gnu.org/software/libtasn1/', 'mingw-w64-libtasn1-4.21.0-1'),
  C('mingw-w64-ucrt-x86_64-libunistring', '1.4.2-1', 'copyleft', 'LGPL-3.0-or-later OR GPL-3.0-or-later', ['LGPL-3.0', 'GPL-3.0'], 'https://www.gnu.org/software/libunistring/', 'mingw-w64-libunistring-1.4.2-1'),
  C('mingw-w64-ucrt-x86_64-libwinpthread', '14.0.0.r536.g7ce22f663-1', 'permissive', 'MIT AND BSD-3-Clause', ['winpthreads'], 'https://www.mingw-w64.org/', M('mingw-w64-winpthreads', '14.0.0.r536.g7ce22f663-1')),
  C('mingw-w64-ucrt-x86_64-nghttp2', '1.70.0-1', 'permissive', 'MIT', ['nghttp2'], 'https://nghttp2.org/', M('mingw-w64-nghttp2', '1.70.0-1')),
  C('mingw-w64-ucrt-x86_64-openssl', '3.5.9-1', 'permissive', 'Apache-2.0', ['openssl'], 'https://openssl-library.org/', G('2026-09-30T09-24-18.347486000Z', 'mingw-w64-openssl-3.5.9-1.src.tar.gz')),
  C('mingw-w64-ucrt-x86_64-pcre2', '10.49-1', 'permissive', 'BSD-3-Clause WITH PCRE2-exception', ['pcre2'], 'https://pcre.org/', M('mingw-w64-pcre2', '10.49-1')),
  C('mingw-w64-ucrt-x86_64-zlib', '1.3.2-3', 'permissive', 'Zlib', ['zlib'], 'https://www.zlib.net/', M('mingw-w64-zlib', '1.3.2-3')),
  C('mingw-w64-ucrt-x86_64-zstd', '1.5.7-2', 'permissive', 'BSD-3-Clause', ['zstd'], 'https://facebook.github.io/zstd/', M('mingw-w64-zstd', '1.5.7-2'), 'dual-licensed BSD-3-Clause OR GPL-2.0-only; distributed here under BSD-3-Clause'),
  C('mpfr', '4.2.2-1', 'copyleft', 'LGPL-3.0-or-later', ['LGPL-3.0', 'GPL-3.0'], 'https://www.mpfr.org/', 'mpfr-4.2.2-1'),
  C('msys2-runtime', '3.6.10-4', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0', 'LGPL-3.0'], 'https://github.com/git-for-windows/msys2-runtime', 'msys2-runtime-3.6.10-4', 'Git for Windows\' own build of the MSYS2 (Cygwin-derived) runtime; MSYS2 labels it GPL-3.0-or-later'),
  C('ncurses', '6.6-2', 'permissive', 'MIT (X11 style)', ['ncurses'], 'https://invisible-island.net/ncurses/', S('ncurses', '6.6-2')),
  C('openssh', '10.6p1-1', 'permissive', 'LicenseRef-OpenSSH (BSD-style)', ['openssh'], 'https://www.openssh.com/portable.html', G('2026-10-06T21-47-39.107137000Z', 'openssh-10.6p1-1.src.tar.gz')),
  C('openssl', '3.5.9-1', 'permissive', 'Apache-2.0', ['openssl'], 'https://openssl-library.org/', G('2026-09-30T08-56-50.408104900Z', 'openssl-3.5.9-1.src.tar.gz')),
  C('sed', '4.9-1', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/sed/', 'sed-4.9-1'),
  C('bash', '5.3.015-2', 'copyleft', 'GPL-3.0-or-later', ['GPL-3.0'], 'https://www.gnu.org/software/bash/', 'bash-5.3.015-2'),
  C('zlib', '1.3.2-1', 'permissive', 'Zlib', ['zlib'], 'https://www.zlib.net/', S('zlib', '1.3.2-1')),
  C('filesystem', '2026.10.17-1', 'permissive', 'BSD-3-Clause', ['msys2-filesystem'], 'https://github.com/msys2/MSYS2-packages/tree/master/filesystem', S('filesystem', '2026.10.17-1')),
  C('dash', '0.5.13.5-1', 'copyleft', 'BSD-3-Clause AND GPL-2.0-or-later', ['dash', 'GPL-2.0'], 'http://gondor.apana.org.au/~herbert/dash/', 'dash-0.5.13.5-1'),
  C('rebase', '4.5.0-5', 'copyleft', 'GPL-2.0', ['GPL-2.0'], 'https://sourceware.org/git/?p=cygwin-apps/rebase.git', 'rebase-4.5.0-5', 'MSYS2 labels it "custom"; the project\'s COPYING is the GNU GPL version 2'),
]);

/** "name version" → the table row, or null. */
export function componentFor(line, table = MINGIT_COMPONENTS) {
  const m = /^(\S+)\s+(\S+)$/.exec(String(line || '').trim());
  if (!m) return null;
  return table.find((c) => c.name === m[1] && c.version === m[2]) || null;
}

/**
 * Compare a package-versions.txt component list with the table, both ways.
 * {ok, unknown: [lines the table does not classify], absent: [table rows
 * the list does not have]}. Duplicate lines (MinGit lists some twice) count once.
 */
export function classifyComponents(lines, table = MINGIT_COMPONENTS) {
  const uniq = [...new Set((lines || []).map((l) => String(l).trim()).filter(Boolean))];
  const unknown = uniq.filter((l) => !componentFor(l, table));
  const present = new Set(uniq);
  const absent = table.filter((c) => !present.has(`${c.name} ${c.version}`)).map((c) => `${c.name} ${c.version}`);
  return { ok: unknown.length === 0 && absent.length === 0, unknown, absent };
}

/** The COPYLEFT_SOURCES entry a row points at, or null (permissive rows). */
export function sourceFor(component, sources = COPYLEFT_SOURCES) {
  return sources.find((s) => s.key === component.source) || null;
}
