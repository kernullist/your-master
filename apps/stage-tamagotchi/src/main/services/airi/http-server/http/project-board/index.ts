import type { ProjectManagementStore } from '../../../project-management/store'
import type { ServerManager } from '../../server-manager/types'

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { createNextWorkItemIdentifier } from '@proj-airi/stage-projects'
import { ipcMain, shell } from 'electron'
import { eventHandler, H3, readBody } from 'h3'

import {
  projectManagementGetBoardUrl,
  projectManagementOpenBoardExternal,
} from '../../../../../../shared/eventa/project-management'
import { createH3Server } from '../../server'

/**
 * Renders the standalone local project board HTML.
 *
 * Use when:
 * - AIRI serves `/project-board` from the built-in localhost server
 *
 * Expects:
 * - The browser can call same-origin `/project-board/api/snapshot`
 *
 * Returns:
 * - Complete HTML document with embedded CSS and a small board script
 */
export function renderProjectBoardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Board</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f7f8fb; color: #18202f; }
    body { margin: 0; min-height: 100vh; }
    header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid #dde2eb; background: color-mix(in srgb, Canvas 92%, transparent); backdrop-filter: blur(12px); }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; }
    button { border: 1px solid #cfd6e3; background: #fff; color: #1d2738; border-radius: 8px; padding: 8px 10px; font: inherit; cursor: pointer; }
    button:hover { background: #eef3f8; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .primary { border-color: #2962ff; background: #2962ff; color: #fff; }
    .primary:hover { background: #1d4ed8; }
    .project-strip { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: stretch; padding: 12px 16px 0; }
    .project-card { color-scheme: dark; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; border: 1px solid #3d4a61; border-radius: 8px; background: #1d2533 !important; color: #ecf1f8 !important; padding: 10px 12px; }
    .project-card strong { color: #f5f8fc !important; font-size: 14px; }
    .project-card code { grid-column: 1 / -1; white-space: normal; word-break: break-all; color: #c7d2e3 !important; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    .project-badge { justify-self: start; border: 1px solid #4b5a73; border-radius: 999px; background: #273247 !important; padding: 3px 8px; color: #d7dfec !important; font-size: 12px; }
    .project-switcher { min-width: 220px; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; padding: 16px; }
    .board { display: grid; grid-template-columns: repeat(6, minmax(180px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
    .column { min-height: 70vh; border: 1px solid #dfe5ef; border-radius: 8px; background: #ffffffb8; }
    .column h2 { display: flex; justify-content: space-between; margin: 0; padding: 10px 12px; border-bottom: 1px solid #e6ebf2; font-size: 13px; text-transform: uppercase; letter-spacing: 0; }
    .cards { display: grid; gap: 8px; padding: 8px; }
    .card { border: 1px solid #d7deea; border-radius: 8px; background: #fff; padding: 10px; text-align: left; }
    .card strong { display: block; font-size: 13px; }
    .card span { display: block; margin-top: 4px; color: #667085; font-size: 12px; }
    .detail { border: 1px solid #dfe5ef; border-radius: 8px; background: #ffffffc7; padding: 14px; min-height: 240px; }
    .detail h2 { margin: 0 0 8px; font-size: 16px; }
    form { display: grid; gap: 10px; }
    label { display: grid; gap: 5px; color: #667085; font-size: 12px; }
    input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid #cfd6e3; border-radius: 8px; background: #fff; color: #1d2738; padding: 8px 10px; font: inherit; }
    textarea { min-height: 86px; resize: vertical; }
    .meta { color: #667085; font-size: 12px; }
    .comments { display: grid; gap: 8px; margin-top: 12px; }
    .comment { border-left: 3px solid #81a7f9; padding-left: 8px; font-size: 12px; white-space: pre-wrap; }
    .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .project-list { display: grid; gap: 8px; }
    .project-list-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; border: 1px solid #d7deea; border-radius: 8px; background: #fff; padding: 10px; text-align: left; }
    .project-list-item.selected { border-color: #2962ff; box-shadow: 0 0 0 1px #2962ff inset; }
    .project-list-item strong { display: block; font-size: 13px; }
    .project-list-item span { display: block; margin-top: 4px; color: #667085; font-size: 12px; word-break: break-all; }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; } .board { grid-template-columns: repeat(6, 220px); } .project-strip { grid-template-columns: 1fr; } .project-switcher { min-width: 0; } }
    @media (prefers-color-scheme: dark) {
      :root { background: #10141d; color: #ecf1f8; }
      header, .column, .detail { border-color: #293142; background: #151b27d9; }
      .column h2 { border-color: #293142; }
      .card, button, input, select, textarea { border-color: #313a4d; background: #1d2533; color: #ecf1f8; }
      button:hover { background: #273247; }
      .project-list-item { border-color: #313a4d; background: #1d2533; color: #ecf1f8; }
      label, .card span, .project-list-item span, .meta { color: #9aa6b8; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Project Board</h1>
    <div class="header-actions">
      <button id="create-project">New project</button>
      <button class="primary" id="create-work-item">New work item</button>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <section class="project-strip" id="projects"></section>
  <main>
    <section class="board" id="board"></section>
    <aside class="detail" id="detail">Select a work item.</aside>
  </main>
  <script>
    const statuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
    let snapshot = { projects: [], workItems: [], comments: [], runs: [] };
    let selectedProjectId = null;
    let selectedId = null;
    let detailMode = 'empty';

    function selectedProject() {
      return snapshot.projects.find(project => project.id === selectedProjectId) ?? snapshot.projects[0] ?? null;
    }

    function projectWorkItems() {
      const project = selectedProject();
      if (!project) {
        return [];
      }
      return snapshot.workItems.filter(item => item.projectId === project.id);
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]);
    }

    async function setStatus(id, status) {
      await fetch('/project-board/api/work-items/' + encodeURIComponent(id) + '/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await load();
    }

    function splitCriteria(value) {
      return String(value ?? '').split(/\\r?\\n/).map(item => item.trim()).filter(Boolean);
    }

    async function createWorkItem(payload) {
      await fetch('/project-board/api/work-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    async function createProject(payload) {
      await fetch('/project-board/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    async function deleteProject(id) {
      await fetch('/project-board/api/projects/' + encodeURIComponent(id), {
        method: 'DELETE',
      });
      if (selectedProjectId === id) {
        selectedProjectId = null;
      }
      selectedId = null;
      detailMode = 'empty';
      await load();
    }

    async function updateWorkItem(id, payload) {
      await fetch('/project-board/api/work-items/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    async function deleteWorkItem(id) {
      await fetch('/project-board/api/work-items/' + encodeURIComponent(id), {
        method: 'DELETE',
      });
      selectedId = null;
      detailMode = 'empty';
      await load();
    }

    function renderWorkItemForm(item) {
      const isCreate = !item;
      const project = isCreate ? selectedProject() : snapshot.projects.find(candidate => candidate.id === item.projectId);
      const el = document.getElementById('detail');
      if (isCreate && !project) {
        el.innerHTML = '<h2>No project registered</h2><p class="meta">Register a local project before creating work items.</p>';
        return;
      }

      el.innerHTML = '<h2>' + (isCreate ? 'New work item' : escapeHtml(item.identifier)) + '</h2>'
        + '<form id="work-item-form">'
        + (isCreate && snapshot.projects.length > 1
          ? '<label>Project<select name="projectId">' + snapshot.projects.map(candidate => '<option value="' + escapeHtml(candidate.id) + '"' + (project?.id === candidate.id ? ' selected' : '') + '>' + escapeHtml(candidate.name) + ' · ' + escapeHtml(candidate.issuePrefix) + '</option>').join('') + '</select></label>'
          : '<input type="hidden" name="projectId" value="' + escapeHtml(project?.id) + '">')
        + '<label>Title<input name="title" required value="' + escapeHtml(item?.title) + '"></label>'
        + '<label>Commit prefix<input name="commitPrefix" placeholder="AC-781" value="' + escapeHtml(item?.commitPrefix) + '"></label>'
        + '<label>Goal<textarea name="goal" required>' + escapeHtml(item?.goal) + '</textarea></label>'
        + '<label>Acceptance criteria<textarea name="acceptanceCriteria" required>' + escapeHtml((item?.acceptanceCriteria ?? []).join('\\n')) + '</textarea></label>'
        + (isCreate ? '' : '<label>Status<select name="status">' + statuses.map(status => '<option value="' + status + '"' + (item?.status === status ? ' selected' : '') + '>' + status + '</option>').join('') + '</select></label>')
        + '<div class="actions">'
        + '<button class="primary" type="submit">' + (isCreate ? 'Create' : 'Save') + '</button>'
        + '<button type="button" data-action="cancel-edit">Cancel</button>'
        + '</div>'
        + '</form>';

      const form = el.querySelector('#work-item-form');
      form.onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
          projectId: String(data.get('projectId') ?? ''),
          title: String(data.get('title') ?? ''),
          commitPrefix: String(data.get('commitPrefix') ?? '').trim() || null,
          goal: String(data.get('goal') ?? ''),
          acceptanceCriteria: splitCriteria(data.get('acceptanceCriteria')),
        };
        if (isCreate) {
          await createWorkItem(payload);
          detailMode = 'empty';
          selectedId = null;
          await load();
          return;
        }

        detailMode = 'view';
        await updateWorkItem(item.id, {
          ...payload,
          status: String(data.get('status') ?? item.status),
        });
        await load();
      };
      el.querySelector('[data-action="cancel-edit"]').onclick = () => {
        detailMode = selectedId ? 'view' : 'empty';
        renderDetail();
      };
    }

    function renderProjectForm() {
      const el = document.getElementById('detail');
      el.innerHTML = '<h2>New project</h2>'
        + '<form id="project-form">'
        + '<label>Folder path<input name="rootPath" required placeholder="F:\\\\workspace\\\\my-project"></label>'
        + '<label>Issue prefix<input name="issuePrefix" required placeholder="BC"></label>'
        + '<label>Name<input name="name" placeholder="Optional"></label>'
        + '<div class="actions">'
        + '<button class="primary" type="submit">Create</button>'
        + '<button type="button" data-action="cancel-project">Cancel</button>'
        + '</div>'
        + '</form>';

      const form = el.querySelector('#project-form');
      form.onsubmit = async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        await createProject({
          rootPath: String(data.get('rootPath') ?? ''),
          issuePrefix: String(data.get('issuePrefix') ?? ''),
          name: String(data.get('name') ?? '').trim() || undefined,
        });
        detailMode = 'empty';
        selectedId = null;
        await load();
      };
      el.querySelector('[data-action="cancel-project"]').onclick = () => {
        detailMode = selectedId ? 'view' : 'empty';
        renderDetail();
      };
    }

    function renderProjects() {
      const el = document.getElementById('projects');
      const project = selectedProject();
      if (!snapshot.projects.length) {
        el.innerHTML = '<article class="project-card"><strong>No project registered</strong><span class="project-badge">empty</span><code>Register a local project from the New project button.</code></article><button class="project-switcher" id="show-projects">Projects</button>';
        el.querySelector('#show-projects').onclick = () => {
          selectedId = null;
          detailMode = 'projects';
          renderDetail();
        };
        return;
      }

      el.innerHTML = '<article class="project-card">'
        + '<strong>' + escapeHtml(project?.name) + ' · ' + escapeHtml(project?.issuePrefix) + '</strong>'
        + '<span class="project-badge">' + (project?.gitEnabled ? 'git' : 'no git') + '</span>'
        + '<code>' + escapeHtml(project?.rootPath) + '</code>'
        + '<div class="project-actions">'
        + '<span class="meta">' + projectWorkItems().length + ' work items</span>'
        + '</div>'
        + '</article>'
        + '<button class="project-switcher" id="show-projects">Projects</button>';
      el.querySelector('#show-projects').onclick = () => {
        selectedId = null;
        detailMode = 'projects';
        renderDetail();
      };
    }

    function renderProjectList() {
      const el = document.getElementById('detail');
      if (!snapshot.projects.length) {
        el.innerHTML = '<h2>Projects</h2><p class="meta">No project registered.</p>';
        return;
      }

      el.innerHTML = '<h2>Projects</h2>'
        + '<div class="project-list">'
        + snapshot.projects.map(project =>
          '<div class="project-list-item' + (selectedProject()?.id === project.id ? ' selected' : '') + '">'
          + '<div><strong>' + escapeHtml(project.name) + ' · ' + escapeHtml(project.issuePrefix) + '</strong><span>' + escapeHtml(project.rootPath) + '</span></div>'
          + '<div class="actions">'
          + (selectedProject()?.id === project.id ? '<span class="meta">Selected</span>' : '<button data-project-select="' + escapeHtml(project.id) + '">Select</button>')
          + '<button data-project-delete="' + escapeHtml(project.id) + '">Delete</button>'
          + '</div>'
          + '</div>'
        ).join('')
        + '</div>';
      el.querySelectorAll('[data-project-select]').forEach(node => node.onclick = () => {
        selectedProjectId = node.dataset.projectSelect;
        selectedId = null;
        detailMode = 'empty';
        renderProjects();
        renderBoard();
      });
      el.querySelectorAll('[data-project-delete]').forEach(node => node.onclick = () => {
        const project = snapshot.projects.find(candidate => candidate.id === node.dataset.projectDelete);
        if (project && confirm(project.name + ' 프로젝트를 삭제할까요? 연결된 일감도 함께 삭제돼요.')) {
          void deleteProject(project.id);
        }
      });
    }

    function renderDetail() {
      const el = document.getElementById('detail');
      if (detailMode === 'projects') {
        renderProjectList();
        return;
      }
      if (detailMode === 'create-project') {
        renderProjectForm();
        return;
      }
      if (detailMode === 'create') {
        renderWorkItemForm(null);
        return;
      }
      const item = snapshot.workItems.find(card => card.id === selectedId);
      if (!item) {
        el.textContent = 'Select a work item.';
        return;
      }
      const comments = snapshot.comments.filter(comment => comment.workItemId === item.id);
      const run = snapshot.runs.filter(candidate => candidate.workItemId === item.id).at(-1);
      el.innerHTML = '<h2>' + item.identifier + '</h2>'
        + '<div class="meta">' + item.status + ' · ' + item.title + '</div>'
        + (item.commitPrefix ? '<div class="meta">Commit prefix · ' + escapeHtml(item.commitPrefix) + '</div>' : '')
        + (run?.branchName ? '<div class="meta">Branch · ' + escapeHtml(run.branchName) + '</div>' : '')
        + (run?.worktreePath ? '<div class="meta">Worktree · ' + escapeHtml(run.worktreePath) + '</div>' : '')
        + '<p>' + item.goal + '</p>'
        + '<div class="actions">'
        + '<button data-action="edit">Edit</button>'
        + '<button data-action="start">Start</button>'
        + '<button data-action="delete">Delete</button>'
        + '</div>'
        + '<div class="comments">' + comments.map(comment => '<div class="comment"><strong>' + comment.actorType + ' · ' + comment.kind + '</strong><br>' + comment.content + '</div>').join('') + '</div>';
      el.querySelector('[data-action="edit"]').onclick = () => {
        detailMode = 'edit';
        renderWorkItemForm(item);
      };
      el.querySelector('[data-action="start"]').onclick = () => setStatus(item.id, 'in_progress');
      el.querySelector('[data-action="delete"]').onclick = () => {
        if (confirm(item.identifier + ' 일감을 삭제할까요?')) {
          void deleteWorkItem(item.id);
        }
      };
    }

    function renderBoard() {
      const board = document.getElementById('board');
      const visibleItems = projectWorkItems();
      board.innerHTML = statuses.map(status => {
        const items = visibleItems.filter(item => item.status === status);
        return '<section class="column"><h2><span>' + status + '</span><span>' + items.length + '</span></h2><div class="cards">'
          + items.map(item => '<button class="card" data-id="' + item.id + '"><strong>' + item.identifier + '</strong><span>' + item.title + '</span></button>').join('')
          + '</div></section>';
      }).join('');
      board.querySelectorAll('[data-id]').forEach(node => node.onclick = () => {
        selectedId = node.dataset.id;
        detailMode = 'view';
        renderDetail();
      });
      renderDetail();
    }

    async function load() {
      snapshot = await fetch('/project-board/api/snapshot').then(response => response.json());
      if (selectedProjectId && !snapshot.projects.some(project => project.id === selectedProjectId)) {
        selectedProjectId = null;
        selectedId = null;
        detailMode = 'empty';
      }
      if (!selectedProjectId && snapshot.projects.length > 0) {
        selectedProjectId = snapshot.projects[0].id;
      }
      renderProjects();
      renderBoard();
    }

    function applySnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
      if (selectedProjectId && !snapshot.projects.some(project => project.id === selectedProjectId)) {
        selectedProjectId = null;
        selectedId = null;
        detailMode = 'empty';
      }
      if (!selectedProjectId && snapshot.projects.length > 0) {
        selectedProjectId = snapshot.projects[0].id;
      }
      renderProjects();
      renderBoard();
    }

    function connectRealtimeUpdates() {
      if (!('EventSource' in window)) {
        window.setInterval(load, 1500);
        return;
      }

      const events = new EventSource('/project-board/api/events');
      events.addEventListener('snapshot', (event) => {
        applySnapshot(JSON.parse(event.data));
      });
      events.onerror = () => {
        events.close();
        window.setTimeout(connectRealtimeUpdates, 1500);
      };
    }

    document.getElementById('refresh').onclick = load;
    document.getElementById('create-project').onclick = () => {
      selectedId = null;
      detailMode = 'create-project';
      renderDetail();
    };
    document.getElementById('create-work-item').onclick = () => {
      selectedId = null;
      detailMode = 'create';
      renderDetail();
    };
    load();
    connectRealtimeUpdates();
  </script>
</body>
</html>`
}

function encodeProjectBoardEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Creates the localhost project board server.
 *
 * Use when:
 * - AIRI should expose a browser-only local Kanban board while the app is running
 *
 * Expects:
 * - `store` is the project-management store from Electron main
 *
 * Returns:
 * - Server lifecycle manager with a board URL getter
 */
export function createProjectBoardServer(options: {
  store: Pick<ProjectManagementStore, 'createWorkItem' | 'deleteProject' | 'deleteWorkItem' | 'getSnapshot' | 'registerProject' | 'subscribeSnapshot' | 'updateWorkItem'>
  host?: string
  registerEventa?: boolean
}): ServerManager & { getBoardUrl: () => string | undefined } {
  const app = new H3()
  const server = createH3Server({ app, host: options.host ?? '127.0.0.1' })
  const textEncoder = new TextEncoder()

  app.get('/project-board', eventHandler(() => {
    return new Response(renderProjectBoardHtml(), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }))

  app.get('/project-board/api/snapshot', eventHandler(() => {
    return options.store.getSnapshot()
  }))

  app.get('/project-board/api/events', eventHandler(() => {
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let unsubscribe: (() => void) | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode(encodeProjectBoardEvent('snapshot', options.store.getSnapshot())))
        unsubscribe = options.store.subscribeSnapshot((snapshot) => {
          controller.enqueue(textEncoder.encode(encodeProjectBoardEvent('snapshot', snapshot)))
        })
        heartbeat = setInterval(() => {
          controller.enqueue(textEncoder.encode(': keep-alive\n\n'))
        }, 30000)
      },
      cancel() {
        unsubscribe?.()
        if (heartbeat)
          clearInterval(heartbeat)
      },
    })

    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    })
  }))

  app.post('/project-board/api/projects', eventHandler(async (event) => {
    const body = await readBody<{
      issuePrefix?: string
      name?: string
      rootPath?: string
    }>(event) ?? {}
    const rootPath = body.rootPath?.trim()
    const issuePrefix = body.issuePrefix?.trim()
    if (!rootPath || !issuePrefix)
      return new Response('Bad Request', { status: 400 })

    return options.store.registerProject({
      rootPath,
      issuePrefix,
      name: body.name?.trim() || undefined,
      gitEnabled: existsSync(join(rootPath, '.git')),
    })
  }))

  app.delete('/project-board/api/projects/:id', eventHandler((event) => {
    const id = event.context.params?.id
    if (!id)
      return new Response('Bad Request', { status: 400 })

    options.store.deleteProject(id)
    return { ok: true }
  }))

  app.post('/project-board/api/work-items', eventHandler(async (event) => {
    const body = await readBody<{
      acceptanceCriteria?: string[]
      commitPrefix?: string | null
      goal?: string
      projectId?: string
      title?: string
    }>(event) ?? {}
    const snapshot = options.store.getSnapshot()
    const project = snapshot.projects.find(item => item.id === body.projectId) ?? snapshot.projects[0]
    const title = body.title?.trim()
    const goal = body.goal?.trim()
    const acceptanceCriteria = body.acceptanceCriteria?.map(item => item.trim()).filter(Boolean) ?? []

    if (!project || !title || !goal || acceptanceCriteria.length === 0)
      return new Response('Bad Request', { status: 400 })

    const result = options.store.createWorkItem({
      projectId: project.id,
      identifier: createNextWorkItemIdentifier({
        issuePrefix: project.issuePrefix,
        identifiers: snapshot.workItems.filter(item => item.projectId === project.id).map(item => item.identifier),
      }),
      title,
      goal,
      acceptanceCriteria,
      commitPrefix: body.commitPrefix?.trim() || undefined,
    })

    if (result.duplicate || !result.workItem)
      return new Response('Duplicate identifier', { status: 409 })

    return result.workItem
  }))

  app.patch('/project-board/api/work-items/:id', eventHandler(async (event) => {
    const id = event.context.params?.id
    const body = await readBody<{
      acceptanceCriteria?: string[]
      commitPrefix?: string | null
      goal?: string
      status?: Parameters<ProjectManagementStore['updateWorkItem']>[0]['patch']['status']
      title?: string
    }>(event) ?? {}
    if (!id)
      return new Response('Bad Request', { status: 400 })

    const patch: Parameters<ProjectManagementStore['updateWorkItem']>[0]['patch'] = {}
    if (body.title?.trim())
      patch.title = body.title.trim()
    if (body.goal?.trim())
      patch.goal = body.goal.trim()
    if (body.acceptanceCriteria) {
      const acceptanceCriteria = body.acceptanceCriteria.map(item => item.trim()).filter(Boolean)
      if (acceptanceCriteria.length > 0)
        patch.acceptanceCriteria = acceptanceCriteria
    }
    if (body.commitPrefix !== undefined)
      patch.commitPrefix = body.commitPrefix?.trim() || null
    if (body.status)
      patch.status = body.status

    return options.store.updateWorkItem({
      id,
      patch,
    })
  }))

  app.delete('/project-board/api/work-items/:id', eventHandler((event) => {
    const id = event.context.params?.id
    if (!id)
      return new Response('Bad Request', { status: 400 })

    options.store.deleteWorkItem(id)
    return { ok: true }
  }))

  app.post('/project-board/api/work-items/:id/status', eventHandler(async (event) => {
    const id = event.context.params?.id
    const body = await readBody<{ status?: string }>(event) ?? {}
    if (!id || !body.status)
      return new Response('Bad Request', { status: 400 })

    return options.store.updateWorkItem({
      id,
      patch: { status: body.status as Parameters<ProjectManagementStore['updateWorkItem']>[0]['patch']['status'] },
    })
  }))

  if (options.registerEventa ?? true) {
    const { context } = createContext(ipcMain)
    defineInvokeHandler(context, projectManagementGetBoardUrl, async () => ({
      url: server.getAddress()?.baseUrl ? `${server.getAddress()?.baseUrl}/project-board` : undefined,
    }))
    defineInvokeHandler(context, projectManagementOpenBoardExternal, async () => {
      const url = server.getAddress()?.baseUrl ? `${server.getAddress()?.baseUrl}/project-board` : undefined
      if (!url)
        return { opened: false }

      await shell.openExternal(url)
      return { opened: true, url }
    })
  }

  return {
    key: 'project-board',
    async start() {
      await server.start()
    },
    async stop() {
      await server.stop()
    },
    getBoardUrl() {
      return server.getAddress()?.baseUrl ? `${server.getAddress()?.baseUrl}/project-board` : undefined
    },
  }
}
