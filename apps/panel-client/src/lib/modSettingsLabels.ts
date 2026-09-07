export function formatModSettingLabel(value: string | undefined, groupName?: string): string {
  let label = String(value || '').trim()
  if (!label) return ''

  const isInternalKey = /^Sandbox_/i.test(label) || /[_\.]/.test(label) || /[a-z\d][A-Z]/.test(label)
  if (!isInternalKey) return label

  label = label.replace(/^Sandbox_/i, '')

  if (groupName) {
    const normalizedGroup = groupName.replace(/^Sandbox_/i, '').replace(/[^a-z0-9]/gi, '')
    const normalizedLabel = label.replace(/[^a-z0-9]/gi, '')
    if (normalizedGroup && normalizedLabel.toLowerCase().startsWith(normalizedGroup.toLowerCase())) {
      const groupPrefix = label.match(new RegExp(`^${escapeRegExp(groupName.replace(/^Sandbox_/i, ''))}_[.]?`, 'i'))
      if (groupPrefix) label = label.slice(groupPrefix[0].length)
    }
  }

  return label
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatModSettingDescription(value: string | undefined): string {
  const text = String(value || '').replace(/\\n/g, '\n').trim()
  if (!text) return ''

  if (!/\s/.test(text) && (/^Sandbox_/i.test(text) || /[_\.]/.test(text))) return ''
  return text
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
