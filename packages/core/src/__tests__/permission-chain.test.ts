import { describe, expect, test } from 'vitest'
import { defaultPermissions, PermissionSet } from '../system/permission'

describe('M7: 链式命令不得被通配符 allow 放行', () => {
  test('追加的通配符 allow（ls *）不应放行链式破坏命令', () => {
    const ps = new PermissionSet([
      { action: 'bash', resource: '*', effect: 'ask' },
      { action: 'bash', resource: 'ls *', effect: 'allow' },
    ])
    expect(ps.evaluateResource('bash', 'ls -la')).toBe('allow')
    expect(ps.evaluateResource('bash', 'ls -la && rm -rf *')).toBe('ask')
    expect(ps.evaluateResource('bash', 'ls -la | node')).toBe('ask')
    expect(ps.evaluateResource('bash', 'ls -la; rm -rf *')).toBe('ask')
  })

  test('cat 通配符 allow 不应放行追加破坏命令', () => {
    const ps = new PermissionSet([
      { action: 'bash', resource: '*', effect: 'ask' },
      { action: 'bash', resource: 'cat *', effect: 'allow' },
    ])
    expect(ps.evaluateResource('bash', 'cat a.js')).toBe('allow')
    expect(ps.evaluateResource('bash', 'cat a.js && rm -rf /tmp')).toBe('ask')
  })

  test('精确链式命令仍可用显式 allow 规则放行', () => {
    const ps = new PermissionSet([
      { action: 'bash', resource: '*', effect: 'ask' },
      { action: 'bash', resource: 'npm run build && npm test', effect: 'allow' },
    ])
    expect(ps.evaluateResource('bash', 'npm run build && npm test')).toBe('allow')
    expect(ps.evaluateResource('bash', 'npm run build && rm -rf /')).toBe('ask')
  })

  test('复合格式规则 bash:ls * 同样受保护', () => {
    const ps = new PermissionSet([
      { action: 'bash', resource: '*', effect: 'ask' },
      { action: 'bash:ls *', resource: '*', effect: 'allow' },
    ])
    expect(ps.evaluateResource('bash', 'ls -la')).toBe('allow')
    expect(ps.evaluateResource('bash', 'ls -la && echo hi')).toBe('ask')
  })
})

describe('M7: 默认权限集行为', () => {
  test('链式命令不应晚于通配符 allow 自动放行', () => {
    expect(defaultPermissions.evaluateResource('bash', 'ls && echo test')).toBe('ask')
    expect(defaultPermissions.evaluateResource('bash', 'echo hi | sort')).toBe('ask')
    expect(defaultPermissions.evaluateResource('bash', 'pwd; whoami')).toBe('ask')
  })
})