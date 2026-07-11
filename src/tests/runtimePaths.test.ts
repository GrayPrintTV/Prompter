import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_WHISPER_MODEL_NAME,
  LOCAL_WHISPER_PYTHON_ENV_VAR,
  devEnvFileRoots,
  isDevRuntime,
  localWhisperSpawnErrorMessage,
  missingBundledModelMessage,
  missingBundledSidecarMessage,
  missingPythonExecutableMessage,
  resolveBundledWhisperModelPath,
  resolveBundledWhisperSidecarPath,
  resolveLocalWhisperLaunchPlan,
  resolveLocalWhisperSidecarPath,
  resolveLocalWhisperWorkingDirectory,
  resolvePythonExecutablePath,
  resolveRendererIndexPath,
  type RuntimePathContext
} from '../../electron/runtimePaths';

const DEV_CONTEXT: RuntimePathContext = {
  isPackaged: false,
  appPath: 'C:\\dev\\Prompter',
  mainDirname: 'C:\\dev\\Prompter\\dist-electron',
  resourcesPath: 'C:\\dev\\Prompter',
  env: { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' }
};

const PACKAGED_CONTEXT: RuntimePathContext = {
  ...DEV_CONTEXT,
  isPackaged: true,
  appPath: 'C:\\Program Files\\Prompter\\resources\\app.asar',
  mainDirname: 'C:\\Program Files\\Prompter\\resources\\app.asar\\dist-electron',
  resourcesPath: 'C:\\Program Files\\Prompter\\resources'
};

describe('runtime path resolution', () => {
  it('keeps development resources rooted at the Electron app path', () => {
    expect(isDevRuntime(DEV_CONTEXT)).toBe(true);
    expect(devEnvFileRoots(DEV_CONTEXT)).toEqual(['C:\\dev\\Prompter']);
    expect(resolveLocalWhisperSidecarPath(DEV_CONTEXT)).toBe(
      path.join('C:\\dev\\Prompter', 'python', 'local_whisper_sidecar.py')
    );
    expect(resolveRendererIndexPath(DEV_CONTEXT)).toBe(
      path.join('C:\\dev\\Prompter\\dist-electron', '..', 'dist', 'index.html')
    );
  });

  it('uses process resources for packaged sidecar resources and ignores dev-server env', () => {
    expect(isDevRuntime(PACKAGED_CONTEXT)).toBe(false);
    expect(devEnvFileRoots(PACKAGED_CONTEXT)).toEqual([]);
    expect(resolveBundledWhisperSidecarPath(PACKAGED_CONTEXT)).toBe(
      path.join('C:\\Program Files\\Prompter\\resources', 'whisper-sidecar', 'whisper-sidecar.exe')
    );
    expect(resolveBundledWhisperModelPath(PACKAGED_CONTEXT)).toBe(
      path.join('C:\\Program Files\\Prompter\\resources', 'models', BUNDLED_WHISPER_MODEL_NAME)
    );
  });

  it('builds a development sidecar launch plan using Python and the source-tree script', () => {
    const plan = resolveLocalWhisperLaunchPlan(
      DEV_CONTEXT,
      'python',
      'base.en',
      'C:\\Users\\Ada\\AppData\\Roaming\\Prompter',
      { [LOCAL_WHISPER_PYTHON_ENV_VAR]: 'C:\\Python313\\python.exe' }
    );

    expect(plan).toMatchObject({
      executablePath: 'C:\\Python313\\python.exe',
      args: [path.join('C:\\dev\\Prompter', 'python', 'local_whisper_sidecar.py')],
      scriptPath: path.join('C:\\dev\\Prompter', 'python', 'local_whisper_sidecar.py'),
      modelName: 'base.en',
      modelPath: null,
      localFilesOnly: false,
      bundled: false,
      workingDirectory: path.join('C:\\Users\\Ada\\AppData\\Roaming\\Prompter', 'local-whisper-sidecar')
    });
  });

  it('builds a packaged sidecar launch plan using the bundled executable and bundled model', () => {
    const plan = resolveLocalWhisperLaunchPlan(
      PACKAGED_CONTEXT,
      'python',
      'ignored-user-model',
      'C:\\Users\\Ada\\AppData\\Roaming\\Prompter',
      { [LOCAL_WHISPER_PYTHON_ENV_VAR]: 'C:\\Python313\\python.exe' }
    );

    expect(plan).toMatchObject({
      executablePath: path.join('C:\\Program Files\\Prompter\\resources', 'whisper-sidecar', 'whisper-sidecar.exe'),
      args: [],
      scriptPath: null,
      modelName: BUNDLED_WHISPER_MODEL_NAME,
      modelPath: path.join('C:\\Program Files\\Prompter\\resources', 'models', BUNDLED_WHISPER_MODEL_NAME),
      localFilesOnly: true,
      bundled: true,
      workingDirectory: path.join('C:\\Users\\Ada\\AppData\\Roaming\\Prompter', 'local-whisper-sidecar')
    });
    expect(plan.executablePath).not.toContain('Python313');
    expect(plan.executablePath).not.toContain('python.exe');
  });

  it('does not use process.cwd when resolving packaged launch paths', () => {
    const plan = resolveLocalWhisperLaunchPlan(
      {
        ...PACKAGED_CONTEXT,
        appPath: 'D:\\Somewhere Else\\resources\\app.asar',
        resourcesPath: 'D:\\Somewhere Else\\resources'
      },
      'python',
      'base.en',
      'C:\\Users\\Ada\\AppData\\Roaming\\Prompter',
      {}
    );

    expect(plan.executablePath).toBe(
      path.join('D:\\Somewhere Else\\resources', 'whisper-sidecar', 'whisper-sidecar.exe')
    );
    expect(plan.modelPath).toBe(
      path.join('D:\\Somewhere Else\\resources', 'models', BUNDLED_WHISPER_MODEL_NAME)
    );
  });

  it('keeps sidecar working files under userData', () => {
    expect(resolveLocalWhisperWorkingDirectory('C:\\Users\\Ada\\AppData\\Roaming\\Prompter')).toBe(
      path.join('C:\\Users\\Ada\\AppData\\Roaming\\Prompter', 'local-whisper-sidecar')
    );
  });

  it('supports an environment override for the Python executable', () => {
    expect(
      resolvePythonExecutablePath('python', {
        [LOCAL_WHISPER_PYTHON_ENV_VAR]: 'C:\\Python313\\python.exe'
      })
    ).toBe('C:\\Python313\\python.exe');
    expect(resolvePythonExecutablePath('python', {})).toBe('python');
  });

  it('formats missing Python startup errors with the override hint', () => {
    const error = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
    expect(localWhisperSpawnErrorMessage(error, 'python')).toBe(
      missingPythonExecutableMessage('python')
    );
  });

  it('formats packaged missing executable and model errors', () => {
    const executable = path.join('C:\\Program Files\\Prompter\\resources', 'whisper-sidecar', 'whisper-sidecar.exe');
    const error = Object.assign(new Error('spawn bundled ENOENT'), { code: 'ENOENT' });
    expect(localWhisperSpawnErrorMessage(error, executable, true)).toBe(
      missingBundledSidecarMessage(executable)
    );
    expect(missingBundledModelMessage('C:\\Prompter\\resources\\models\\base.en', ['model.bin'])).toContain(
      'Missing: model.bin.'
    );
  });
});
