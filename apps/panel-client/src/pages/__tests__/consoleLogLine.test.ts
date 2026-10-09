import { expect, it } from 'vite-plus/test'
import { isNoise, parseLogLine } from '../console/logLine'

it('reads the level, category, time and message from a game log line', () => {
  const parsed = parseLogLine('LOG  : General      f:0, t:1700000000000> Server started')
  expect(parsed).toMatchObject({ type: 'LOG', category: 'General', message: 'Server started' })
  expect(parsed.time).toMatch(/^\d{2}:\d{2}:\d{2}$/)
})

it('treats Java exceptions and stack lines as errors', () => {
  expect(parseLogLine('LOG  : General f:0> java.lang.NullPointerException').type).toBe('ERROR')
  expect(parseLogLine('    at zombie.Foo.bar(Foo.java:12)').type).toBe('ERROR')
  expect(parseLogLine('WARN something odd').type).toBe('WARN')
  expect(parseLogLine('plain text').type).toBe('UNKNOWN')
})

it('flags known noise lines only', () => {
  expect(isNoise('LOG : General > moveZombie: There are no zombies nearby')).toBe(true)
  expect(isNoise('LOG : General > Player joined')).toBe(false)
})
