import { useState } from 'react'
import { MessageSquare, ScrollText, Terminal } from 'lucide-react'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { PageHeader } from '@/components/PageHeader'
import { useShell } from '@/components/shell/useShellStatus'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { CommandsPanel } from './CommandsPanel'
import { MessagesPanel } from './MessagesPanel'
import { RconStatus } from './RconStatus'
import { ServerLogPanel } from './ServerLogPanel'
import { useRconLink } from './useRconLink'

type ConsoleTab = 'log' | 'commands' | 'messages'

export default function ConsolePage() {
  const { selectedServer } = useShell()
  const [tab, setTab] = useState<ConsoleTab>('log')
  const hasLogSource = Boolean(selectedServer?.zomboidDataPath || selectedServer?.installPath)
  const link = useRconLink(Boolean(selectedServer?.rconHost && selectedServer.rconPort && selectedServer.rconPassword))

  usePageShortcut('`', () => setTab((current) => (current === 'log' ? 'commands' : 'log')))

  return (
    <div className="grid gap-6">
      <PageHeader title="Console" description="The server log, RCON commands and messages to players." />
      <Tabs value={tab} onValueChange={(value) => setTab(value as ConsoleTab)} className="gap-4">
        <TabsList>
          <TabsTab value="log">
            <ScrollText />
            Server log
          </TabsTab>
          <TabsTab value="commands">
            <Terminal />
            Commands
          </TabsTab>
          <TabsTab value="messages">
            <MessageSquare />
            Messages
          </TabsTab>
        </TabsList>
        <TabsPanel value="log">
          <ServerLogPanel hasLogSource={hasLogSource} />
        </TabsPanel>
        <TabsPanel value="commands" keepMounted className="grid gap-3 data-hidden:hidden">
          <RconStatus link={link} />
          <CommandsPanel link={link} active={tab === 'commands'} />
        </TabsPanel>
        <TabsPanel value="messages" className="grid gap-3">
          <RconStatus link={link} />
          <MessagesPanel link={link} />
        </TabsPanel>
      </Tabs>
    </div>
  )
}
