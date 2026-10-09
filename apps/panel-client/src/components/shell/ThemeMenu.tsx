import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemeName } from '@/contexts/ThemeContext'
import { Button } from '@/components/ui/button'
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/menu'

export function ThemeMenu() {
  const { theme, setTheme } = useTheme()
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Theme" />}>
        <Sun className="dark:hidden" />
        <Moon className="hidden dark:block" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeName)}>
          <MenuRadioItem value="system">
            <Monitor />
            System
          </MenuRadioItem>
          <MenuRadioItem value="light">
            <Sun />
            Light
          </MenuRadioItem>
          <MenuRadioItem value="dark">
            <Moon />
            Dark
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  )
}
