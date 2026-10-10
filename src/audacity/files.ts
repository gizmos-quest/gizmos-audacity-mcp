import { existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { SafeString } from '../catalogue.js';

export function validateExportFile(file: string): void {
  SafeString.min(1).parse(file);
  // Opus Export2 opens a modal error; AIFF fails (live 3.7.8, 2026-10-02).
  if (!['.wav', '.flac', '.mp3', '.ogg'].includes(extname(file).toLowerCase())) {
    throw new Error('export requires a .wav, .flac, .mp3 or .ogg filename');
  }
  const parent = dirname(resolve(file));
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    throw new Error(`${parent} is not an existing export directory`);
  if (existsSync(file) && !statSync(file).isFile()) throw new Error(`${file} is not a regular export file`);
}

/** Every Import2 route: Audacity-3.7.8 src/ProjectFileManager.cpp:1539-1546 answers an
 * .aup3 import with an error dialog; .aup and .lof are projects/lists, not audio (:1588-1598). */
export function validateImportFile(file: string): void {
  SafeString.min(1).parse(file);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${file} is not an existing audio file`);
  if (/\.(?:aup3|aup|lof)$/i.test(file))
    throw new Error('Import2 imports audio; open .aup3 projects with audacity_project');
}

export function validateProjectFile(file: string, save: boolean): void {
  SafeString.min(1).parse(file);
  if (extname(file).toLowerCase() !== '.aup3') throw new Error('project paths must end in .aup3');
  if (save && existsSync(file))
    throw new Error(`${file} exists; save under a new name to avoid a blocking modal error`);
  if (!save && (!existsSync(file) || !statSync(file).isFile()))
    throw new Error(`${file} is not an existing project file`);
  const parent = dirname(resolve(file));
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    throw new Error(`${parent} is not an existing project directory`);
}
