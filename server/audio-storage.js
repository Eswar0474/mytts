import path from 'node:path';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';

const SAFE_JOB_ID = /^[a-z0-9:_-]+$/i;

function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !SAFE_JOB_ID.test(jobId)) throw new Error('Invalid audio job id.');
}

export function createAudioStorage(root) {
  const rootPath = path.resolve(root || path.resolve(process.cwd(), '.audio-data'));

  const jobDirectory = jobId => {
    assertJobId(jobId);
    return path.join(rootPath, 'jobs', jobId);
  };
  const segmentsDirectory = jobId => path.join(jobDirectory(jobId), 'segments');
  const finalRelativeKey = (jobId, extension) => {
    assertJobId(jobId);
    if (!/^[a-z0-9]+$/i.test(extension)) throw new Error('Invalid audio extension.');
    return path.posix.join('jobs', jobId, `final.${extension}`);
  };
  const pathForKey = key => {
    if (typeof key !== 'string' || !key || key.includes('\0')) throw new Error('Invalid audio storage key.');
    const normalized = key.replaceAll('\\', '/');
    const clean = path.posix.normalize(normalized);
    if (clean.startsWith('../') || clean === '..' || clean.startsWith('/')) throw new Error('Invalid audio storage key.');
    const resolved = path.resolve(rootPath, ...clean.split('/'));
    if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) throw new Error('Invalid audio storage key.');
    return resolved;
  };

  async function ensureRoot() {
    await mkdir(rootPath, { recursive: true });
    return rootPath;
  }

  async function ensureJob(jobId) {
    await mkdir(segmentsDirectory(jobId), { recursive: true });
    return jobDirectory(jobId);
  }

  async function removeJob(jobId) {
    await rm(jobDirectory(jobId), { recursive: true, force: true });
  }

  async function listSegmentFiles(jobId) {
    try {
      const names = await readdir(segmentsDirectory(jobId));
      return names.filter(name => name.endsWith('.flac')).sort().map(name => path.join(segmentsDirectory(jobId), name));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function statKey(key) {
    try { return await stat(pathForKey(key)); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }

  return {
    rootPath,
    ensureRoot,
    ensureJob,
    removeJob,
    jobDirectory,
    segmentsDirectory,
    finalRelativeKey,
    pathForKey,
    listSegmentFiles,
    statKey
  };
}
