import { expect, test } from 'bun:test'
import { canonicalizeAgentState } from '../src/presence/agent-state'

test('running and active map to working', () => {
  expect(canonicalizeAgentState('running')).toBe('working')
  expect(canonicalizeAgentState('active')).toBe('working')
  expect(canonicalizeAgentState('in-progress')).toBe('working')
  expect(canonicalizeAgentState('IN_PROGRESS')).toBe('working')
})

test('error and failed map to blocked', () => {
  expect(canonicalizeAgentState('error')).toBe('blocked')
  expect(canonicalizeAgentState('failed')).toBe('blocked')
  expect(canonicalizeAgentState('Interrupted')).toBe('blocked')
})

test('needs_input maps to waiting', () => {
  expect(canonicalizeAgentState('needs_input')).toBe('waiting')
  expect(canonicalizeAgentState('needs-input')).toBe('waiting')
  expect(canonicalizeAgentState('permission')).toBe('waiting')
})

test('complete and finished map to done', () => {
  expect(canonicalizeAgentState('complete')).toBe('done')
  expect(canonicalizeAgentState('finished')).toBe('done')
  expect(canonicalizeAgentState('idle')).toBe('done')
})

test('canonical Orca states pass through', () => {
  expect(canonicalizeAgentState('working')).toBe('working')
  expect(canonicalizeAgentState('blocked')).toBe('blocked')
  expect(canonicalizeAgentState('waiting')).toBe('waiting')
  expect(canonicalizeAgentState('done')).toBe('done')
})

test('unknown or missing states become done (idle) and never stay raw', () => {
  expect(canonicalizeAgentState('exfiltrating-secrets')).toBe('done')
  expect(canonicalizeAgentState(undefined)).toBe('done')
  expect(canonicalizeAgentState('')).toBe('done')
  expect(canonicalizeAgentState('   ')).toBe('done')
})
