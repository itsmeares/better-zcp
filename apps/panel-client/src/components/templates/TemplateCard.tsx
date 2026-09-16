import { Lock, Eye, Download, Trash2, Package } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SimTemplate } from '@/lib/api'
import { formatDifficultyLabel } from '@/lib/templateLabels'

interface TemplateCardProps {
  template: SimTemplate
  onPreview: (template: SimTemplate) => void
  onExport: (template: SimTemplate) => void
  onDelete: (template: SimTemplate) => void
}

export function TemplateCard({
  template,
  onPreview,
  onExport,
  onDelete,
}: TemplateCardProps) {
  const changeCount =
    Object.keys(template.serverIni || {}).length +
    Object.values(template.sandboxVars || {}).reduce(
      (n, s) => n + Object.keys(s || {}).length,
      0,
    )

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{template.meta.name}</CardTitle>
          <Badge
            variant={template.isBuiltin ? 'secondary' : 'outline'}
            className="shrink-0 gap-1"
          >
            {template.isBuiltin && <Lock className="h-3 w-3" />}
            {template.isBuiltin ? 'Built-in' : 'Custom'}
          </Badge>
        </div>
        <CardDescription className="line-clamp-3 min-w-0">
          {template.meta.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="default">
            {formatDifficultyLabel(template.difficulty?.level)}
          </Badge>
          {template.meta.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {Number(changeCount) === 1
            ? String(changeCount) + ' setting overridden'
            : String(changeCount) + ' settings overridden'}
          {template.mods.length > 0 && (
            <span className="ms-1 inline-flex items-center gap-1">
              <Package className="h-3 w-3" />
              {Number(template.mods.length) === 1
                ? String(template.mods.length) + ' mod'
                : String(template.mods.length) + ' mods'}
            </span>
          )}
        </p>
        <div className="mt-auto flex items-center gap-2 pt-2">
          <Button
            size="sm"
            onClick={() => onPreview(template)}
            className="flex-1"
          >
            <Eye className="h-3.5 w-3.5" />
            {'Preview'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onExport(template)}
            title={'Export template'}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDelete(template)}
            title={'Delete template'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
