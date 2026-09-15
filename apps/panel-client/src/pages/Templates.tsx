import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LayoutTemplate, Plus, Upload, Loader2, RotateCcw } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { templatesApi, SimTemplate } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { TemplateCard } from '@/components/templates/TemplateCard'
import { TemplatePreviewDialog } from '@/components/templates/TemplatePreviewDialog'
import { CreateTemplateDialog } from '@/components/templates/CreateTemplateDialog'
import { ImportTemplateDialog } from '@/components/templates/ImportTemplateDialog'
import { panelQueryKeys } from '@/lib/queryClient'

export default function Templates() {
  const { toast } = useToast()
  const confirm = useConfirm()
  const canManage = true

  const {
    data: templatesData,
    error: templatesError,
    refetch: refetchTemplates,
    isPending: templatesPending,
  } = useQuery({
    queryKey: panelQueryKeys.templates,
    queryFn: templatesApi.list,
    retry: false,
    staleTime: 30_000,
  })
  const { data: hiddenTemplatesData, refetch: refetchHiddenTemplates } =
    useQuery({
      queryKey: panelQueryKeys.hiddenTemplates,
      queryFn: templatesApi.listHidden,
      enabled: canManage,
      retry: false,
      staleTime: 30_000,
    })
  const templates = Array.isArray(templatesData?.templates)
    ? templatesData.templates
    : []
  const hiddenTemplates = Array.isArray(hiddenTemplatesData?.templates)
    ? hiddenTemplatesData.templates
    : []
  const loading = templatesPending
  const loadError = templatesError
    ? getUserErrorMessage(templatesError, 'Failed to load templates.')
    : null
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const [previewTemplate, setPreviewTemplate] = useState<SimTemplate | null>(
    null,
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const fetchTemplates = useCallback(async () => {
    await refetchTemplates()
  }, [refetchTemplates])

  const fetchHiddenTemplates = useCallback(async () => {
    if (canManage) await refetchHiddenTemplates()
  }, [canManage, refetchHiddenTemplates])

  const handleRestore = async (template: SimTemplate) => {
    setRestoringId(template.meta.id)
    try {
      const result = await templatesApi.unhide(template.meta.id)
      if (!result.success)
        throw new Error(result.error || 'Failed to restore template')
      toast({ title: 'Template Restored', variant: 'success' as const })
      await Promise.all([fetchTemplates(), fetchHiddenTemplates()])
    } catch (error) {
      toast({
        title: 'Restore Failed',
        description: getUserErrorMessage(error, 'Failed to restore template'),
        variant: 'destructive',
      })
    } finally {
      setRestoringId(null)
    }
  }

  const handleExport = async (template: SimTemplate) => {
    try {
      const slug = template.meta.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
      await templatesApi.downloadExport(
        template.meta.id,
        slug || template.meta.id,
      )
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: getUserErrorMessage(error, 'Failed to export template'),
        variant: 'destructive',
      })
    }
  }

  const handleDelete = async (template: SimTemplate) => {
    const ok = await confirm(
      template.isBuiltin
        ? {
            title: 'Hide Built-in Template',
            description:
              'Hide "' +
              String(template.meta.name) +
              '" from your list? It\'s built-in, so nothing is deleted -- you can restore it later from the hidden templates section.',
            confirmLabel: 'Hide',
            destructive: false,
          }
        : {
            title: 'Delete Template',
            description:
              'Delete "' +
              String(template.meta.name) +
              '"? This can\'t be undone.',
            destructive: true,
          },
    )
    if (!ok) return
    try {
      const result = await templatesApi.delete(template.meta.id)
      if (!result.success)
        throw new Error(result.error || 'Failed to delete template')
      toast({
        title: template.isBuiltin ? 'Template Hidden' : 'Template Deleted',
        variant: 'success' as const,
      })
      await fetchTemplates()
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: getUserErrorMessage(error, 'Failed to delete template'),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={'Simulation Templates'}
        description={
          'Apply a curated ruleset to your server, or save your own configuration to reuse later.'
        }
        icon={<LayoutTemplate className="h-6 w-6" />}
        tone="config"
        actions={
          canManage ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" />
                {'Import'}
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                {'Save Current Config'}
              </Button>
            </>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={"Couldn't load templates"}
          description={loadError}
          action={{ label: 'Retry', onClick: fetchTemplates }}
        />
      ) : templates.length === 0 ? (
        <EmptyState
          type="empty"
          title={'No templates yet'}
          description={
            'Save your current server configuration as a template, or import one from a file.'
          }
          action={
            canManage
              ? {
                  label: 'Save Current Config',
                  onClick: () => setCreateOpen(true),
                }
              : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.meta.id}
              template={template}
              onPreview={setPreviewTemplate}
              onExport={handleExport}
              onDelete={handleDelete}
              canManage={canManage}
            />
          ))}
        </div>
      )}

      {canManage && hiddenTemplates.length > 0 && (
        <div className="space-y-3 rounded-lg border border-border/70 bg-muted/15 p-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {'Hidden built-in templates'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {
                'Hidden from the list above but not deleted. Restore one to bring it back.'
              }
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hiddenTemplates.map((template) => (
              <div
                key={template.meta.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2"
              >
                <span className="truncate text-sm text-muted-foreground">
                  {template.meta.name}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleRestore(template)}
                  disabled={restoringId === template.meta.id}
                  aria-label={'Restore ' + String(template.meta.name)}
                >
                  {restoringId === template.meta.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  {'Restore'}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <TemplatePreviewDialog
        template={previewTemplate}
        canManage={canManage}
        onClose={() => setPreviewTemplate(null)}
        onApplied={() => setPreviewTemplate(null)}
      />
      {canManage && (
        <>
          <CreateTemplateDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false)
              fetchTemplates()
            }}
          />
          <ImportTemplateDialog
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={() => {
              setImportOpen(false)
              fetchTemplates()
            }}
          />
        </>
      )}
    </div>
  )
}
