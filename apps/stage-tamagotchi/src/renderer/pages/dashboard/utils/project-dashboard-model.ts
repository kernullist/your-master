import type { Project, WorkItem, WorkItemComment, WorkItemRunRecord, WorkItemStatus } from '@proj-airi/stage-projects'

import type { ProjectManagementSnapshot } from '../../../../shared/eventa/project-management'

import { sortWorkItemsForBoard, WORK_ITEM_STATUSES } from '@proj-airi/stage-projects'

/**
 * Available sidebar filters for the project dashboard board.
 */
export type ProjectDashboardFilter = 'all' | 'active' | 'blocked' | 'review' | 'done' | 'recent'

/**
 * Available grouping modes for visible work-item cards.
 */
export type ProjectDashboardGroupBy = 'status' | 'project' | 'activity'

/**
 * Submission body used by the dashboard create/edit work-item dialog.
 */
export interface ProjectWorkItemFormPayload {
  /** Project id used for new work items. Existing work items keep their original project. */
  projectId: string
  /** Existing work item id when editing; omitted when creating. */
  workItemId?: string
  /** User-facing work item identifier such as `AIRI-12`. */
  identifier: string
  /** Short board card title. */
  title: string
  /** User-facing goal that tells AIRI what to accomplish. */
  goal: string
  /** Completion criteria split into validated lines. */
  acceptanceCriteria: string[]
  /** Optional commit prefix. Empty values clear the prefix when editing. */
  commitPrefix?: string
  /** Optional status update when editing. */
  status?: WorkItemStatus
}

/**
 * Display metadata for one work-item status.
 */
export interface ProjectDashboardStatusMeta {
  /** Status value from the project-management domain. */
  status: WorkItemStatus
  /** Human-readable status label. */
  label: string
  /** Iconify/UnoCSS icon class shown in controls and headings. */
  icon: string
  /** Accent background class for dots and progress segments. */
  dotClass: string
  /** Badge classes for status pills. */
  badgeClass: string[]
  /** Soft background classes for column surfaces. */
  surfaceClass: string[]
}

/**
 * Sidebar filter option with static count semantics.
 */
export interface ProjectDashboardFilterOption {
  /** Stable option id. */
  id: ProjectDashboardFilter
  /** Human-readable label. */
  label: string
  /** Iconify/UnoCSS icon class shown beside the label. */
  icon: string
}

/**
 * Grouping option for the dashboard toolbar.
 */
export interface ProjectDashboardGroupOption {
  /** Stable option id. */
  id: ProjectDashboardGroupBy
  /** Human-readable label. */
  label: string
  /** Iconify/UnoCSS icon class shown in the select option. */
  icon: string
}

/**
 * One enriched board card derived from raw project-management records.
 */
export interface ProjectDashboardCard {
  /** Raw work item persisted by project management. */
  item: WorkItem
  /** Project attached to the card, if still registered. */
  project?: Project
  /** Latest runner record for the work item, if any. */
  latestRun?: WorkItemRunRecord
  /** Latest compact comment attached to the work item, if any. */
  latestComment?: WorkItemComment
  /** Millisecond timestamp used for recency sorting and relative labels. */
  activityAt: number
  /** Short relative activity label such as `12분 전`. */
  activityLabel: string
  /** Short preview text shown on compact cards. */
  previewText: string
}

/**
 * One visual board group/column.
 */
export interface ProjectDashboardGroup {
  /** Stable group id. */
  id: string
  /** Column title. */
  title: string
  /** Optional column subtitle. */
  subtitle?: string
  /** Iconify/UnoCSS icon class for the column. */
  icon: string
  /** Accent class for the column dot. */
  dotClass: string
  /** Cards contained in this column. */
  cards: ProjectDashboardCard[]
}

/**
 * Aggregate counters for the selected dashboard scope.
 */
export interface ProjectDashboardMetrics {
  /** Total cards in the current project scope before text/sidebar filtering. */
  total: number
  /** Cards that are not completed. */
  active: number
  /** Completed cards. */
  done: number
  /** Blocked cards. */
  blocked: number
  /** Review cards. */
  review: number
  /** Recently active cards within the last 24 hours. */
  recent: number
  /** Completion percentage from 0 to 100. */
  progress: number
  /** Short health label derived from status distribution. */
  healthLabel: string
  /** Status distribution used by the stacked progress strip. */
  statusSegments: ProjectDashboardStatusSegment[]
}

/**
 * One status segment in the dashboard distribution strip.
 */
export interface ProjectDashboardStatusSegment {
  /** Status represented by the segment. */
  status: WorkItemStatus
  /** Human-readable status label. */
  label: string
  /** Count of matching cards. */
  count: number
  /** Percentage width in the selected dashboard scope. */
  percent: number
  /** Accent class used as the segment fill. */
  class: string
}

/**
 * Derived dashboard state consumed by Vue components.
 */
export interface ProjectDashboardViewModel {
  /** Raw registered projects. */
  projects: Project[]
  /** All enriched cards in board order. */
  cards: ProjectDashboardCard[]
  /** Cards in the currently selected project scope before text/sidebar filtering. */
  scopedCards: ProjectDashboardCard[]
  /** Cards after project, query, and sidebar filtering. */
  visibleCards: ProjectDashboardCard[]
  /** Grouped visible cards for the board. */
  groups: ProjectDashboardGroup[]
  /** Metrics for the selected project scope. */
  metrics: ProjectDashboardMetrics
  /** Count per sidebar filter in the selected project scope. */
  filterCounts: Record<ProjectDashboardFilter, number>
  /** Selected project, if a project tab is active. */
  selectedProject?: Project
  /** Selected card, if it still exists in the snapshot. */
  selectedCard?: ProjectDashboardCard
  /** First blocked card in the selected scope, if any. */
  focusCard?: ProjectDashboardCard
  /** First in-progress/TODO/review card in the selected scope, if any. */
  nextCard?: ProjectDashboardCard
}

/**
 * Inputs used to build a dashboard view model.
 */
export interface CreateProjectDashboardViewModelInput {
  /** Snapshot loaded from Electron main. */
  snapshot?: ProjectManagementSnapshot
  /** Active project tab; null means all projects. */
  selectedProjectId: string | null
  /** Selected work item id, if any. */
  selectedWorkItemId: string | null
  /** Search query from the toolbar. */
  query: string
  /** Sidebar filter id. */
  filter: ProjectDashboardFilter
  /** Board grouping mode. */
  groupBy: ProjectDashboardGroupBy
  /** Millisecond timestamp used by relative labels and recent filters. */
  now?: number
}

/**
 * Static metadata for every project work-item status.
 */
export const projectDashboardStatusMeta: Record<WorkItemStatus, ProjectDashboardStatusMeta> = {
  todo: {
    status: 'todo',
    label: 'TODO',
    icon: 'i-solar:list-check-bold-duotone',
    dotClass: 'bg-neutral-400',
    badgeClass: ['border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'],
    surfaceClass: ['bg-neutral-50/80 dark:bg-neutral-950/30'],
  },
  in_progress: {
    status: 'in_progress',
    label: '진행 중',
    icon: 'i-solar:play-circle-bold-duotone',
    dotClass: 'bg-amber-500',
    badgeClass: ['border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200'],
    surfaceClass: ['bg-amber-50/70 dark:bg-amber-950/15'],
  },
  in_review: {
    status: 'in_review',
    label: '리뷰',
    icon: 'i-solar:clipboard-check-bold-duotone',
    dotClass: 'bg-violet-500',
    badgeClass: ['border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200'],
    surfaceClass: ['bg-violet-50/60 dark:bg-violet-950/15'],
  },
  done: {
    status: 'done',
    label: '완료',
    icon: 'i-solar:check-circle-bold-duotone',
    dotClass: 'bg-emerald-500',
    badgeClass: ['border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200'],
    surfaceClass: ['bg-emerald-50/60 dark:bg-emerald-950/15'],
  },
  blocked: {
    status: 'blocked',
    label: '막힘',
    icon: 'i-solar:danger-triangle-bold-duotone',
    dotClass: 'bg-red-500',
    badgeClass: ['border-red-300 bg-red-100 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200'],
    surfaceClass: ['bg-red-50/60 dark:bg-red-950/15'],
  },
}

/**
 * Sidebar filters shown in the project dashboard rail.
 */
export const projectDashboardFilterOptions: ProjectDashboardFilterOption[] = [
  { id: 'all', label: '전체', icon: 'i-solar:widget-4-bold-duotone' },
  { id: 'active', label: '활성', icon: 'i-solar:bolt-circle-bold-duotone' },
  { id: 'blocked', label: '막힘', icon: 'i-solar:danger-triangle-bold-duotone' },
  { id: 'review', label: '리뷰', icon: 'i-solar:clipboard-check-bold-duotone' },
  { id: 'done', label: '완료', icon: 'i-solar:check-circle-bold-duotone' },
  { id: 'recent', label: '최근 활동', icon: 'i-solar:clock-circle-bold-duotone' },
]

/**
 * Grouping modes shown in the dashboard toolbar.
 */
export const projectDashboardGroupOptions: ProjectDashboardGroupOption[] = [
  { id: 'status', label: '상태별', icon: 'i-solar:kanban-bold-duotone' },
  { id: 'project', label: '프로젝트별', icon: 'i-solar:folder-with-files-bold-duotone' },
  { id: 'activity', label: '활동별', icon: 'i-solar:clock-circle-bold-duotone' },
]

const activityBucketOrder = ['today', 'yesterday', 'week', 'month', 'older'] as const

/**
 * Builds derived dashboard state from raw project-management data.
 *
 * Use when:
 * - Vue components need stable project, filter, group, metric, and selection state
 * - Electron snapshot events replace the full project-management snapshot
 *
 * Expects:
 * - Snapshot records are already validated by the project-management service
 * - `selectedProjectId` is null for the all-projects view
 *
 * Returns:
 * - A render-ready view model with no side effects
 */
export function createProjectDashboardViewModel(input: CreateProjectDashboardViewModelInput): ProjectDashboardViewModel {
  const snapshot = input.snapshot
  const now = input.now ?? Date.now()
  const projects = snapshot?.projects ?? []
  const cards = snapshot ? createCards(snapshot, now) : []
  const selectedProject = input.selectedProjectId
    ? projects.find(project => project.id === input.selectedProjectId)
    : undefined
  const scopedCards = input.selectedProjectId
    ? cards.filter(card => card.item.projectId === input.selectedProjectId)
    : cards
  const visibleCards = filterCards(scopedCards, input.query, input.filter, now)
  const groups = groupCards(visibleCards, projects, input.groupBy, now)
  const metrics = createMetrics(scopedCards, now)
  const filterCounts = createFilterCounts(scopedCards, now)
  const selectedCard = input.selectedWorkItemId
    ? cards.find(card => card.item.id === input.selectedWorkItemId)
    : undefined
  const focusCard = scopedCards.find(card => card.item.status === 'blocked')
  const nextCard = scopedCards.find(card => card.item.status === 'in_progress')
    ?? scopedCards.find(card => card.item.status === 'todo')
    ?? scopedCards.find(card => card.item.status === 'in_review')

  return {
    projects,
    cards,
    scopedCards,
    visibleCards,
    groups,
    metrics,
    filterCounts,
    selectedProject,
    selectedCard,
    focusCard,
    nextCard,
  }
}

function createCards(snapshot: ProjectManagementSnapshot, now: number): ProjectDashboardCard[] {
  const projects = new Map(snapshot.projects.map(project => [project.id, project]))
  const commentsByWorkItem = groupCommentsByWorkItem(snapshot.comments)
  const runsByWorkItem = groupRunsByWorkItem(snapshot.runs)

  return sortWorkItemsForBoard(snapshot.workItems).map((item) => {
    const latestRun = runsByWorkItem.get(item.id)
    const latestComment = commentsByWorkItem.get(item.id)
    const activityAt = latestActivityAt(item, latestRun, latestComment)

    return {
      item,
      project: projects.get(item.projectId),
      latestRun,
      latestComment,
      activityAt,
      activityLabel: formatRelativeActivity(activityAt, now),
      previewText: createPreviewText(item, latestRun, latestComment),
    }
  })
}

function groupCommentsByWorkItem(comments: WorkItemComment[]): Map<string, WorkItemComment> {
  const latest = new Map<string, WorkItemComment>()
  for (const comment of comments) {
    const current = latest.get(comment.workItemId)
    if (!current || comment.createdAt > current.createdAt)
      latest.set(comment.workItemId, comment)
  }
  return latest
}

function groupRunsByWorkItem(runs: WorkItemRunRecord[]): Map<string, WorkItemRunRecord> {
  const latest = new Map<string, WorkItemRunRecord>()
  for (const run of runs) {
    const current = latest.get(run.workItemId)
    if (!current || runActivityAt(run) > runActivityAt(current))
      latest.set(run.workItemId, run)
  }
  return latest
}

function runActivityAt(run: WorkItemRunRecord): number {
  return run.finishedAt ?? run.lastActivityAt ?? run.startedAt
}

function latestActivityAt(item: WorkItem, run: WorkItemRunRecord | undefined, comment: WorkItemComment | undefined): number {
  return Math.max(
    item.updatedAt,
    run ? runActivityAt(run) : 0,
    comment?.createdAt ?? 0,
  )
}

function createPreviewText(item: WorkItem, run: WorkItemRunRecord | undefined, comment: WorkItemComment | undefined): string {
  if (run?.error)
    return run.error
  if (run?.reviewerComment)
    return run.reviewerComment
  if (run?.workerComment)
    return run.workerComment
  if (run?.diffSummary)
    return run.diffSummary
  if (comment?.content)
    return comment.content
  return item.goal
}

function filterCards(cards: ProjectDashboardCard[], queryValue: string, filter: ProjectDashboardFilter, now: number): ProjectDashboardCard[] {
  const query = queryValue.trim().toLowerCase()
  const filtered = cards.filter(card => matchesFilter(card, filter, now))

  if (!query)
    return filtered

  return filtered.filter(card => searchFields(card).some(value => value.toLowerCase().includes(query)))
}

function searchFields(card: ProjectDashboardCard): string[] {
  return [
    card.item.identifier,
    card.item.title,
    card.item.goal,
    card.item.commitPrefix ?? '',
    card.project?.name ?? '',
    card.project?.issuePrefix ?? '',
    card.project?.rootPath ?? '',
    card.item.acceptanceCriteria.join('\n'),
    card.latestComment?.content ?? '',
    card.latestRun?.branchName ?? '',
    card.latestRun?.diffSummary ?? '',
    card.latestRun?.testSummary ?? '',
    card.latestRun?.error ?? '',
  ].filter(Boolean)
}

function matchesFilter(card: ProjectDashboardCard, filter: ProjectDashboardFilter, now: number): boolean {
  switch (filter) {
    case 'active':
      return card.item.status !== 'done'
    case 'blocked':
      return card.item.status === 'blocked'
    case 'review':
      return card.item.status === 'in_review'
    case 'done':
      return card.item.status === 'done'
    case 'recent':
      return isRecentlyActive(card.activityAt, now)
    case 'all':
      return true
  }
}

function groupCards(cards: ProjectDashboardCard[], projects: Project[], groupBy: ProjectDashboardGroupBy, now: number): ProjectDashboardGroup[] {
  if (groupBy === 'status')
    return groupCardsByStatus(cards)

  if (groupBy === 'activity')
    return groupCardsByActivity(cards, now)

  return groupCardsByProject(cards, projects)
}

function groupCardsByStatus(cards: ProjectDashboardCard[]): ProjectDashboardGroup[] {
  const itemGroups = new Map(cards.map(card => [card.item.id, card]))
  const grouped = {
    todo: [] as ProjectDashboardCard[],
    in_progress: [] as ProjectDashboardCard[],
    in_review: [] as ProjectDashboardCard[],
    done: [] as ProjectDashboardCard[],
    blocked: [] as ProjectDashboardCard[],
  }

  for (const status of WORK_ITEM_STATUSES) {
    for (const item of sortWorkItemsForBoard(cards.map(card => card.item)).filter(item => item.status === status)) {
      const card = itemGroups.get(item.id)
      if (card)
        grouped[status].push(card)
    }
  }

  return WORK_ITEM_STATUSES.map((status) => {
    const meta = projectDashboardStatusMeta[status]
    return {
      id: `status:${status}`,
      title: meta.label,
      icon: meta.icon,
      dotClass: meta.dotClass,
      cards: grouped[status],
    }
  })
}

function groupCardsByProject(cards: ProjectDashboardCard[], projects: Project[]): ProjectDashboardGroup[] {
  const projectMap = new Map(projects.map(project => [project.id, project]))
  const grouped = new Map<string, ProjectDashboardCard[]>()
  for (const card of cards) {
    const key = card.project?.id ?? card.item.projectId
    grouped.set(key, [...(grouped.get(key) ?? []), card])
  }

  return [...grouped.entries()].map(([projectId, projectCards]) => {
    const project = projectMap.get(projectId)
    return {
      id: `project:${projectId}`,
      title: project ? `${project.name} · ${project.issuePrefix}` : '알 수 없는 프로젝트',
      subtitle: project?.rootPath,
      icon: 'i-solar:folder-with-files-bold-duotone',
      dotClass: project?.gitEnabled ? 'bg-sky-500' : 'bg-neutral-400',
      cards: projectCards,
    }
  })
}

function groupCardsByActivity(cards: ProjectDashboardCard[], now: number): ProjectDashboardGroup[] {
  const grouped = new Map<(typeof activityBucketOrder)[number], ProjectDashboardCard[]>(
    activityBucketOrder.map(bucket => [bucket, []]),
  )
  for (const card of cards) {
    const bucket = activityBucket(card.activityAt, now)
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), card])
  }

  return activityBucketOrder.map(bucket => ({
    id: `activity:${bucket}`,
    title: activityBucketLabel(bucket),
    icon: 'i-solar:clock-circle-bold-duotone',
    dotClass: activityBucketDotClass(bucket),
    cards: grouped.get(bucket) ?? [],
  }))
}

function createMetrics(cards: ProjectDashboardCard[], now: number): ProjectDashboardMetrics {
  if (cards.length === 0)
    return createEmptyMetrics()

  const statusCounts = countStatuses(cards)
  const done = statusCounts.done
  const blocked = statusCounts.blocked
  const review = statusCounts.in_review
  const active = cards.length - done
  const recent = cards.filter(card => isRecentlyActive(card.activityAt, now)).length
  const progress = Math.round((done / cards.length) * 100)

  return {
    total: cards.length,
    active,
    done,
    blocked,
    review,
    recent,
    progress,
    healthLabel: projectHealthLabel({ total: cards.length, active, done, blocked, review }),
    statusSegments: WORK_ITEM_STATUSES.map(status => ({
      status,
      label: projectDashboardStatusMeta[status].label,
      count: statusCounts[status],
      percent: Math.round((statusCounts[status] / cards.length) * 100),
      class: projectDashboardStatusMeta[status].dotClass,
    })),
  }
}

function createEmptyMetrics(): ProjectDashboardMetrics {
  return {
    total: 0,
    active: 0,
    done: 0,
    blocked: 0,
    review: 0,
    recent: 0,
    progress: 0,
    healthLabel: '대기 중',
    statusSegments: WORK_ITEM_STATUSES.map(status => ({
      status,
      label: projectDashboardStatusMeta[status].label,
      count: 0,
      percent: 0,
      class: projectDashboardStatusMeta[status].dotClass,
    })),
  }
}

function createFilterCounts(cards: ProjectDashboardCard[], now: number): Record<ProjectDashboardFilter, number> {
  return {
    all: cards.length,
    active: cards.filter(card => matchesFilter(card, 'active', now)).length,
    blocked: cards.filter(card => matchesFilter(card, 'blocked', now)).length,
    review: cards.filter(card => matchesFilter(card, 'review', now)).length,
    done: cards.filter(card => matchesFilter(card, 'done', now)).length,
    recent: cards.filter(card => matchesFilter(card, 'recent', now)).length,
  }
}

function countStatuses(cards: ProjectDashboardCard[]): Record<WorkItemStatus, number> {
  return cards.reduce<Record<WorkItemStatus, number>>((counts, card) => {
    counts[card.item.status] += 1
    return counts
  }, {
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    blocked: 0,
  })
}

function projectHealthLabel(metrics: Pick<ProjectDashboardMetrics, 'active' | 'blocked' | 'done' | 'review' | 'total'>): string {
  if (metrics.total === 0)
    return '대기 중'
  if (metrics.blocked > 0)
    return '주의 필요'
  if (metrics.active === 0)
    return '완료'
  if (metrics.review > 0)
    return '검토 중'
  return '진행 가능'
}

function isRecentlyActive(value: number, now: number): boolean {
  // Date math is kept here so all recent-count and filter decisions use the same 24h window.
  const diffMs = now - value
  return diffMs >= 0 && diffMs <= 86_400_000
}

function activityBucket(value: number, now: number): (typeof activityBucketOrder)[number] {
  // Calendar-day buckets are intentionally approximate; the dashboard only needs a quick scan grouping.
  const diffDays = Math.floor((now - value) / 86_400_000)
  if (diffDays <= 0)
    return 'today'
  if (diffDays === 1)
    return 'yesterday'
  if (diffDays < 7)
    return 'week'
  if (diffDays < 30)
    return 'month'
  return 'older'
}

function activityBucketLabel(bucket: (typeof activityBucketOrder)[number]): string {
  switch (bucket) {
    case 'today':
      return '오늘'
    case 'yesterday':
      return '어제'
    case 'week':
      return '이번 주'
    case 'month':
      return '이번 달'
    case 'older':
      return '이전'
  }
}

function activityBucketDotClass(bucket: (typeof activityBucketOrder)[number]): string {
  switch (bucket) {
    case 'today':
      return 'bg-sky-500'
    case 'yesterday':
      return 'bg-cyan-500'
    case 'week':
      return 'bg-indigo-500'
    case 'month':
      return 'bg-fuchsia-500'
    case 'older':
      return 'bg-neutral-400'
  }
}

function formatRelativeActivity(value: number, now: number): string {
  if (!Number.isFinite(value) || value <= 0)
    return '활동 없음'

  // Relative time math stays numeric to avoid locale/browser formatting differences in Electron.
  const diffMs = Math.max(0, now - value)
  const minutes = Math.max(1, Math.floor(diffMs / 60_000))
  if (minutes < 60)
    return `${minutes}분 전`

  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}시간 전`

  const days = Math.floor(hours / 24)
  if (days < 30)
    return `${days}일 전`

  const date = new Date(value)
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`
}
