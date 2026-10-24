/**
 * Build-time identity. `scripts/build.mjs --check` fails when this drifts from
 * package.json, so the Host row and the served client bundle always agree.
 *
 * @module dsh-turbo/version
 */

/** Plugin semver, mirrored from package.json. */
export const PLUGIN_VERSION = '0.2.3'

/** Stable machine name (package name, loader row id and client entry id). */
export const PLUGIN_NAME = 'dsh-turbo'
