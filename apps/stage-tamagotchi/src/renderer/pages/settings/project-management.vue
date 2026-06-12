<script setup lang="ts">
import type { AgentModelConfig, AgentModelProvider, ProjectAgentSettings } from '@proj-airi/stage-projects'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { defaultProjectAgentSettings } from '@proj-airi/stage-projects'
import { Button, FieldCheckbox, FieldCombobox, FieldInput, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { computed, onMounted, ref, watch } from 'vue'

import {
  projectManagementDeleteProject,
  projectManagementGetSnapshot,
  projectManagementListCodexCliModels,
  projectManagementRegisterProject,
  projectManagementUpdateSettings,
} from '../../../shared/eventa'

type AgentConfigKey = 'projectManager' | 'worker' | 'reviewer'

interface OpenRouterModel {
  id: string
  name?: string
  context_length?: number
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[]
}

interface CodexCliModel {
  id: string
  name?: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts: string[]
}

const openRouterBaseUrl = 'https://openrouter.ai/api/v1'

const getSnapshot = useElectronEventaInvoke(projectManagementGetSnapshot)
const registerProject = useElectronEventaInvoke(projectManagementRegisterProject)
const deleteProject = useElectronEventaInvoke(projectManagementDeleteProject)
const updateSettings = useElectronEventaInvoke(projectManagementUpdateSettings)
const listCodexCliModels = useElectronEventaInvoke(projectManagementListCodexCliModels)

const isBusy = ref(false)
const statusMessage = ref('')
const errorMessage = ref('')
const rootPath = ref('')
const issuePrefix = ref('')
const snapshot = ref<Awaited<ReturnType<typeof getSnapshot>>>()
const settingsDraft = ref<ProjectAgentSettings>(createSerializableSettings(defaultProjectAgentSettings))
const verifierCommandsText = ref(defaultProjectAgentSettings.verifierCommands.join('\n'))
const shellDenylistText = ref(defaultProjectAgentSettings.shellDenylist.join('\n'))
const shellAllowlistText = ref(defaultProjectAgentSettings.shellAllowlist.join('\n'))
const forbiddenPathPatternsText = ref(defaultProjectAgentSettings.forbiddenPathPatterns.join('\n'))
const openRouterModels = ref<OpenRouterModel[]>([])
const openRouterModelsLoading = ref(false)
const openRouterModelsError = ref('')
const codexCliModels = ref<CodexCliModel[]>([])
const codexCliModelsLoading = ref(false)
const codexCliModelsError = ref('')
let openRouterModelsAbortController: AbortController | undefined

const providerOptions: Array<{ label: string, value: AgentModelProvider }> = [
  { label: 'LM Studio', value: 'lm-studio' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'Codex CLI', value: 'codex-cli' },
]

const agentSections: Array<{ key: AgentConfigKey, title: string, description: string }> = [
  {
    key: 'projectManager',
    title: 'Project Manager',
    description: '일감을 분석하고 워커와 리뷰어에게 전달할 실행 브리프를 만드는 에이전트',
  },
  {
    key: 'worker',
    title: 'Worker',
    description: '허용된 도구로 코드를 읽고 수정하는 코딩 에이전트',
  },
  {
    key: 'reviewer',
    title: 'Reviewer',
    description: '요구사항 충족 여부와 버그 위험을 검토하는 리뷰 에이전트',
  },
]

const openRouterModelOptions = computed(() => openRouterModels.value.map(model => ({
  label: model.name ? `${model.name} (${model.id})` : model.id,
  value: model.id,
  description: model.context_length ? `${model.context_length.toLocaleString()} context` : undefined,
})))

const codexCliModelOptions = computed(() => codexCliModels.value.map(model => ({
  label: model.name ? `${model.name} (${model.id})` : model.id,
  value: model.id,
  description: [
    model.defaultReasoningEffort ? `default ${model.defaultReasoningEffort}` : '',
    model.supportedReasoningEfforts.length ? model.supportedReasoningEfforts.join(', ') : '',
  ].filter(Boolean).join(' · ') || undefined,
})))

const activeOpenRouterApiKey = computed(() => {
  for (const agent of agentSections) {
    const config = settingsDraft.value[agent.key]
    if (config.provider === 'openrouter' && config.apiKey?.trim()) {
      return config.apiKey.trim()
    }
  }

  return ''
})

const hasCodexCliAgent = computed(() => agentSections.some(agent => settingsDraft.value[agent.key].provider === 'codex-cli'))

function applyProviderDefaults() {
  for (const agent of agentSections) {
    const config = settingsDraft.value[agent.key]

    if (config.provider === 'openrouter') {
      config.baseUrl = openRouterBaseUrl
    }

    if (config.provider === 'codex-cli') {
      config.baseUrl = undefined
      config.apiKey = undefined
    }
  }
}

function parseSettingsListText(value: string): string[] {
  return value.split('\n').map(item => item.trim()).filter(Boolean)
}

function isOpenRouterAgent(agentKey: AgentConfigKey) {
  return settingsDraft.value[agentKey].provider === 'openrouter'
}

function isCodexCliAgent(agentKey: AgentConfigKey) {
  return settingsDraft.value[agentKey].provider === 'codex-cli'
}

function shouldUseOpenRouterModelDropdown(agentKey: AgentConfigKey) {
  return isOpenRouterAgent(agentKey) && !!settingsDraft.value[agentKey].apiKey?.trim()
}

function shouldUseCodexCliModelDropdown(agentKey: AgentConfigKey) {
  return isCodexCliAgent(agentKey)
}

function createSerializableAgentConfig(config: AgentModelConfig): AgentModelConfig {
  return {
    provider: config.provider,
    model: String(config.model ?? ''),
    baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
    apiKey: config.apiKey ? String(config.apiKey) : undefined,
    systemPrompt: String(config.systemPrompt ?? ''),
  }
}

function createSerializableSettings(settings: ProjectAgentSettings): ProjectAgentSettings {
  const verifierCommands = Array.isArray(settings.verifierCommands) ? settings.verifierCommands : []

  return {
    projectManager: createSerializableAgentConfig(settings.projectManager),
    worker: createSerializableAgentConfig(settings.worker),
    reviewer: createSerializableAgentConfig(settings.reviewer),
    maxReviewRetries: Number(settings.maxReviewRetries),
    maxConcurrentRuns: Number(settings.maxConcurrentRuns),
    autoCommit: Boolean(settings.autoCommit),
    verifierCommands: verifierCommands.map(item => String(item)),
    shellDenylist: [...settings.shellDenylist].map(item => String(item)),
    shellAllowlist: [...settings.shellAllowlist].map(item => String(item)),
    forbiddenPathPatterns: [...settings.forbiddenPathPatterns].map(item => String(item)),
    timeoutMs: Number(settings.timeoutMs),
  }
}

function createSerializableSettingsDraft(): ProjectAgentSettings {
  applyProviderDefaults()
  const settings = createSerializableSettings(settingsDraft.value)
  return {
    ...settings,
    verifierCommands: parseSettingsListText(verifierCommandsText.value),
    shellDenylist: parseSettingsListText(shellDenylistText.value),
    shellAllowlist: parseSettingsListText(shellAllowlistText.value),
    forbiddenPathPatterns: parseSettingsListText(forbiddenPathPatternsText.value),
  }
}

async function loadOpenRouterModels(apiKey: string) {
  openRouterModelsAbortController?.abort()
  openRouterModelsAbortController = new AbortController()
  openRouterModelsLoading.value = true
  openRouterModelsError.value = ''

  try {
    const response = await fetch(`${openRouterBaseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: openRouterModelsAbortController.signal,
    })

    if (!response.ok) {
      throw new Error(`OpenRouter 모델 목록을 불러오지 못했어. (${response.status})`)
    }

    const payload = await response.json() as OpenRouterModelsResponse
    openRouterModels.value = [...(payload.data ?? [])].sort((a, b) => {
      const aName = a.name ?? a.id
      const bName = b.name ?? b.id
      return aName.localeCompare(bName)
    })
  }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return
    }

    openRouterModels.value = []
    openRouterModelsError.value = errorMessageFrom(error) ?? 'OpenRouter 모델 목록을 불러오지 못했어.'
  }
  finally {
    openRouterModelsLoading.value = false
  }
}

async function loadCodexCliModels() {
  codexCliModelsLoading.value = true
  codexCliModelsError.value = ''

  try {
    const result = await listCodexCliModels()
    codexCliModels.value = result.models
  }
  catch (error) {
    codexCliModels.value = []
    codexCliModelsError.value = errorMessageFrom(error) ?? 'Codex CLI 모델 목록을 불러오지 못했어.'
  }
  finally {
    codexCliModelsLoading.value = false
  }
}

async function refreshSnapshot() {
  snapshot.value = await getSnapshot()
  settingsDraft.value = createSerializableSettings(snapshot.value.settings)
  verifierCommandsText.value = settingsDraft.value.verifierCommands.join('\n')
  shellDenylistText.value = settingsDraft.value.shellDenylist.join('\n')
  shellAllowlistText.value = settingsDraft.value.shellAllowlist.join('\n')
  forbiddenPathPatternsText.value = settingsDraft.value.forbiddenPathPatterns.join('\n')
  applyProviderDefaults()
}

async function handleRegisterProject() {
  isBusy.value = true
  errorMessage.value = ''
  statusMessage.value = ''

  try {
    await registerProject({
      rootPath: rootPath.value,
      issuePrefix: issuePrefix.value,
    })
    rootPath.value = ''
    issuePrefix.value = ''
    await refreshSnapshot()
    statusMessage.value = '프로젝트가 등록됐어.'
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? '프로젝트 등록에 실패했어.'
  }
  finally {
    isBusy.value = false
  }
}

async function handleDeleteProject(id: string) {
  isBusy.value = true
  errorMessage.value = ''
  statusMessage.value = ''

  try {
    await deleteProject({ id })
    await refreshSnapshot()
    statusMessage.value = '프로젝트가 삭제됐어.'
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? '프로젝트 삭제에 실패했어.'
  }
  finally {
    isBusy.value = false
  }
}

async function handleSaveSettings() {
  isBusy.value = true
  errorMessage.value = ''
  statusMessage.value = ''

  try {
    const serializableSettings = createSerializableSettingsDraft()
    await updateSettings(serializableSettings)
    await refreshSnapshot()
    statusMessage.value = '에이전트 설정이 저장됐어.'
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? '에이전트 설정 저장에 실패했어.'
  }
  finally {
    isBusy.value = false
  }
}

onMounted(async () => {
  await refreshSnapshot()
})

watch(
  () => agentSections.map(agent => settingsDraft.value[agent.key].provider),
  applyProviderDefaults,
)

watch(activeOpenRouterApiKey, async (apiKey) => {
  if (!apiKey) {
    openRouterModelsAbortController?.abort()
    openRouterModels.value = []
    openRouterModelsError.value = ''
    openRouterModelsLoading.value = false
    return
  }

  await loadOpenRouterModels(apiKey)
}, { immediate: true })

watch(hasCodexCliAgent, async (enabled) => {
  if (!enabled)
    return

  await loadCodexCliModels()
}, { immediate: true })
</script>

<template>
  <div
    :class="[
      'pb-12',
      'flex flex-col gap-5',
    ]"
  >
    <section
      :class="[
        'rounded-lg border p-4 md:p-5',
        'border-neutral-200/70 bg-white/75 dark:border-neutral-700/70 dark:bg-neutral-900/40',
        'flex flex-col gap-4',
      ]"
    >
      <div :class="['flex items-start justify-between gap-3']">
        <div :class="['flex flex-col gap-1']">
          <h2 :class="['text-lg font-semibold text-neutral-900 dark:text-neutral-100']">
            로컬 프로젝트
          </h2>
          <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
            AIRI가 관리할 프로젝트 폴더와 일감 prefix를 등록해.
          </p>
        </div>
      </div>

      <div :class="['grid gap-3 md:grid-cols-[1fr_180px_auto] md:items-end']">
        <FieldInput
          v-model="rootPath"
          layout="vertical"
          label="폴더 경로"
          description="절대 경로를 입력해. 폴더명은 프로젝트 이름으로 사용돼."
          placeholder="F:\workspace\my-project"
        />
        <FieldInput
          v-model="issuePrefix"
          layout="vertical"
          label="Prefix"
          description="예: AIRI"
          placeholder="AIRI"
        />
        <Button
          icon="i-solar:add-circle-bold"
          label="등록"
          :disabled="isBusy || !rootPath || !issuePrefix"
          @click="handleRegisterProject"
        />
      </div>

      <div
        v-if="snapshot?.projects.length"
        :class="['grid gap-2']"
      >
        <div
          v-for="project in snapshot.projects"
          :key="project.id"
          :class="[
            'rounded-md border px-3 py-2',
            'border-neutral-200/70 bg-neutral-50/80 dark:border-neutral-700/70 dark:bg-neutral-950/30',
            'flex items-center justify-between gap-3',
          ]"
        >
          <div :class="['min-w-0']">
            <div :class="['truncate text-sm font-medium text-neutral-900 dark:text-neutral-100']">
              {{ project.name }} · {{ project.issuePrefix }}
            </div>
            <div :class="['truncate text-xs text-neutral-500 dark:text-neutral-400']">
              {{ project.rootPath }} · {{ project.gitEnabled ? 'git 사용 가능' : 'git 없음' }}
            </div>
          </div>
          <Button
            icon="i-solar:trash-bin-minimalistic-bold"
            variant="danger"
            size="sm"
            label="삭제"
            :disabled="isBusy"
            @click="handleDeleteProject(project.id)"
          />
        </div>
      </div>
      <div
        v-else
        :class="['rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400']"
      >
        등록된 프로젝트가 없어.
      </div>
    </section>

    <section
      :class="[
        'rounded-lg border p-4 md:p-5',
        'border-neutral-200/70 bg-white/75 dark:border-neutral-700/70 dark:bg-neutral-900/40',
        'flex flex-col gap-5',
      ]"
    >
      <div :class="['flex flex-col gap-1']">
        <h2 :class="['text-lg font-semibold text-neutral-900 dark:text-neutral-100']">
          에이전트 모델
        </h2>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          Project Manager, 워커, 리뷰어가 사용할 provider와 모델을 설정해.
        </p>
      </div>

      <div
        v-for="agent in agentSections"
        :key="agent.key"
        :class="[
          'rounded-md border p-3',
          'border-neutral-200/70 bg-neutral-50/80 dark:border-neutral-700/70 dark:bg-neutral-950/30',
          'grid gap-3',
        ]"
      >
        <div :class="['flex flex-col gap-1']">
          <h3 :class="['text-sm font-semibold text-neutral-900 dark:text-neutral-100']">
            {{ agent.title }}
          </h3>
          <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
            {{ agent.description }}
          </p>
        </div>
        <div :class="['grid gap-3 md:grid-cols-3']">
          <FieldSelect
            v-model="settingsDraft[agent.key].provider"
            layout="vertical"
            label="Provider"
            :options="providerOptions"
          />
          <FieldCombobox
            v-if="shouldUseCodexCliModelDropdown(agent.key)"
            v-model="settingsDraft[agent.key].model"
            layout="vertical"
            label="모델"
            :options="codexCliModelOptions"
            :disabled="!!codexCliModelsError || codexCliModelsLoading"
            :placeholder="settingsDraft[agent.key].model || (codexCliModelsLoading ? 'Codex CLI 모델 확인 중...' : 'Codex CLI 모델 선택')"
          >
            <template #empty>
              <div :class="['px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400']">
                {{ codexCliModelsError || (codexCliModelsLoading ? 'Codex CLI 모델 확인 중...' : '표시할 모델이 없어.') }}
              </div>
            </template>
          </FieldCombobox>
          <FieldCombobox
            v-else-if="shouldUseOpenRouterModelDropdown(agent.key)"
            v-model="settingsDraft[agent.key].model"
            layout="vertical"
            label="모델"
            :options="openRouterModelOptions"
            :disabled="!!openRouterModelsError"
            :placeholder="settingsDraft[agent.key].model || (openRouterModelsLoading ? 'OpenRouter 모델 불러오는 중...' : 'OpenRouter 모델 선택')"
          >
            <template #empty>
              <div :class="['px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400']">
                {{ openRouterModelsError || (openRouterModelsLoading ? 'OpenRouter 모델 불러오는 중...' : '표시할 모델이 없어.') }}
              </div>
            </template>
          </FieldCombobox>
          <FieldInput
            v-else
            v-model="settingsDraft[agent.key].model"
            layout="vertical"
            label="모델"
            :placeholder="isOpenRouterAgent(agent.key) ? 'API Key를 입력하면 모델 목록이 표시돼' : 'qwen2.5-coder'"
          />
          <FieldInput
            v-model="settingsDraft[agent.key].baseUrl"
            layout="vertical"
            label="Base URL"
            :disabled="isOpenRouterAgent(agent.key) || isCodexCliAgent(agent.key)"
            placeholder="http://localhost:1234/v1"
          />
        </div>
        <FieldInput
          v-if="!isCodexCliAgent(agent.key)"
          v-model="settingsDraft[agent.key].apiKey"
          layout="vertical"
          type="password"
          label="API Key"
          placeholder="OpenRouter 키가 필요할 때 입력"
        />
        <FieldTextArea
          v-model="settingsDraft[agent.key].systemPrompt"
          label="System prompt"
          :rows="4"
        />
      </div>

      <div :class="['grid gap-3 md:grid-cols-4']">
        <FieldInput
          v-model.number="settingsDraft.maxReviewRetries"
          layout="vertical"
          type="number"
          label="리뷰 재시도"
          description="기본 5회"
        />
        <FieldInput
          v-model.number="settingsDraft.maxConcurrentRuns"
          layout="vertical"
          type="number"
          label="동시 실행 수"
          description="기본 2개"
        />
        <FieldInput
          v-model.number="settingsDraft.timeoutMs"
          layout="vertical"
          type="number"
          label="타임아웃(ms)"
        />
        <FieldCheckbox
          v-model="settingsDraft.autoCommit"
          label="자동 커밋"
          description="리뷰 통과 후 에이전트 변경 파일만 커밋"
        />
      </div>

      <div :class="['grid gap-3 md:grid-cols-4']">
        <FieldTextArea
          v-model="verifierCommandsText"
          label="Verifier 명령"
          :rows="5"
        />
        <FieldTextArea
          v-model="shellDenylistText"
          label="금지 명령"
          :rows="5"
        />
        <FieldTextArea
          v-model="shellAllowlistText"
          label="허용 명령"
          :rows="5"
        />
        <FieldTextArea
          v-model="forbiddenPathPatternsText"
          label="금지 경로"
          :rows="5"
        />
      </div>

      <div :class="['flex justify-end']">
        <Button
          icon="i-solar:diskette-bold"
          label="설정 저장"
          :disabled="isBusy"
          @click="handleSaveSettings"
        />
      </div>
    </section>

    <div
      v-if="statusMessage"
      :class="[
        'rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2',
        'text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
      ]"
    >
      {{ statusMessage }}
    </div>
    <div
      v-if="errorMessage"
      :class="[
        'rounded-md border border-red-200 bg-red-50 px-3 py-2',
        'text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300',
      ]"
    >
      {{ errorMessage }}
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 프로젝트 관리
  subtitle: Settings
  description: 로컬 프로젝트와 AIRI 개발팀 에이전트 설정
  icon: i-solar:kanban-bold-duotone
  settingsEntry: true
  order: 9
  stageTransition:
    name: slide
</route>
