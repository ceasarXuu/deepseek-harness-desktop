import { describe, expect, it } from 'vitest'
import { assembleDesktopDiagnostics } from '../src/diagnostics.ts'
import { en, zh } from '../src/locale.ts'

describe('desktop diagnostics payload', () => {
  it('assembles every field and one copyable block', () => {
    const payload = assembleDesktopDiagnostics({
      applicationVersion: '1.2.3',
      dshVersion: '1.2.3',
      harnessHome: '/home/user/.dsh',
      runtimeLocation: '/home/user/.dsh/closure/1.2.3',
      failure: undefined,
    }, en)
    expect(payload).toEqual({
      applicationVersion: '1.2.3',
      dshVersion: '1.2.3',
      harnessHome: '/home/user/.dsh',
      runtimeLocation: '/home/user/.dsh/closure/1.2.3',
      startupFailed: false,
      startupFailure: undefined,
      block: [
        'Application: 1.2.3',
        'dsh runtime: 1.2.3',
        'Harness home: /home/user/.dsh',
        'Runtime location: /home/user/.dsh/closure/1.2.3',
        'Last start: Succeeded',
      ].join('\n'),
    })
  })

  it('names the last failure and its reason in the block', () => {
    const payload = assembleDesktopDiagnostics({
      applicationVersion: '1.2.3',
      dshVersion: 'unavailable',
      harnessHome: '/home/user/.dsh',
      runtimeLocation: '/home/user/.dsh/closure/1.2.3',
      failure: 'plugin composition failed',
    }, en)
    expect(payload.startupFailed).toBe(true)
    expect(payload.startupFailure).toBe('plugin composition failed')
    expect(payload.block).toContain('Last start: Failed — plugin composition failed')
  })

  it('uses the Chinese labels for the same block', () => {
    const payload = assembleDesktopDiagnostics({
      applicationVersion: '1.2.3',
      dshVersion: '1.2.3',
      harnessHome: '/home/user/.dsh',
      runtimeLocation: '/home/user/.dsh/closure/1.2.3',
      failure: '插件组合失败',
    }, zh)
    expect(payload.block).toBe([
      '应用版本: 1.2.3',
      'dsh 运行时: 1.2.3',
      'Harness 主目录: /home/user/.dsh',
      '运行时位置: /home/user/.dsh/closure/1.2.3',
      '上次启动: 失败 — 插件组合失败',
    ].join('\n'))
  })
})
