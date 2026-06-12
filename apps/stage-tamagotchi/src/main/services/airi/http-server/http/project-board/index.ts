import type {
  StartProjectWorkItemPayload,
  StartProjectWorkItemResult,
} from '../../../../../../shared/eventa/project-management'
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
    :root { color-scheme: light dark; font-family: "Inter Variable", Inter, Pretendard, "Segoe UI", ui-sans-serif, system-ui, sans-serif; background: #f4f6f9; color: #181b22; --bg: #f4f6f9; --surface: #ffffff; --surface-subtle: #f8fafc; --border: #d9dee8; --border-soft: #e7ebf2; --ink: #181b22; --muted: #687182; --muted-soft: #8a93a3; --rail: #11141a; --rail-raised: #191e27; --rail-border: #272d38; --rail-ink: #f6f8fc; --accent: #5167f6; --accent-hover: #4457db; --success: #168060; --warning: #c57916; --review: #7c5cc4; --danger: #c33a35; --shadow: 0 18px 48px #11182712; }
    * { box-sizing: border-box; }
    html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
    body { margin: 0; min-height: 100vh; background: var(--bg); }
    button, input, select, textarea { font: inherit; }
    button { border: 1px solid #d8dce6; background: #fff; color: #242936; border-radius: 7px; padding: 8px 10px; cursor: pointer; transition: background .16s ease, border-color .16s ease, transform .16s ease, box-shadow .16s ease; }
    button:hover { border-color: #c6ccd9; background: #f7f8fb; box-shadow: 0 1px 2px #11182712; }
    button:active { transform: translateY(1px); }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .app-shell { min-height: 100vh; display: grid; grid-template-columns: 272px minmax(0, 1fr); }
    .rail { position: sticky; top: 0; height: 100vh; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); gap: 14px; border-right: 1px solid #e0e3eb; background: #fbfbfd; padding: 16px 12px; }
    .brand { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 4px; }
    .brand h1 { margin: 0; font-size: 14px; line-height: 1.2; letter-spacing: 0; }
    .brand span { color: #707686; font-size: 12px; }
    .rail-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rail-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rail-stat { border: 1px solid #e0e4ee; border-radius: 8px; background: #fff; padding: 9px 10px; }
    .rail-stat strong { display: block; color: #171a21; font-size: 18px; line-height: 1.1; }
    .rail-stat span { color: #727988; font-size: 11px; }
    .project-nav { display: grid; gap: 6px; align-content: start; overflow-y: auto; padding-right: 2px; }
    .project-nav-title { display: flex; justify-content: space-between; color: #777d8c; font-size: 11px; font-weight: 650; text-transform: uppercase; }
    .project-tab { display: grid; gap: 5px; width: 100%; border-color: transparent; background: transparent; padding: 9px 10px; text-align: left; }
    .project-tab:hover { background: #f0f2f7; box-shadow: none; }
    .project-tab.selected { border-color: #d9deea; background: #fff; box-shadow: 0 1px 2px #1118270d; }
    .project-tab strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .project-tab span { overflow: hidden; color: #737b8d; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .project-tab-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
    .project-delete { width: 34px; padding: 0; color: #ffb4ae; }
    .workspace { min-width: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
    header { position: sticky; top: 0; z-index: 3; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 14px 18px; border-bottom: 1px solid #e0e3eb; background: color-mix(in srgb, #fbfbfd 86%, transparent); backdrop-filter: blur(18px); }
    .breadcrumb { color: #747b8c; font-size: 12px; }
    .header-title { margin-top: 4px; overflow: hidden; color: #171a21; font-size: 18px; font-weight: 720; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .primary { border-color: #5b5fc7; background: #5b5fc7; color: #fff; }
    .primary:hover { border-color: #4e52b7; background: #4e52b7; }
    .overview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 480px); gap: 18px; align-items: stretch; padding: 18px; border-bottom: 1px solid #e5e8f0; background: #fff; }
    .project-hero { min-width: 0; display: grid; gap: 10px; }
    .project-kicker { color: #747b8c; font-size: 12px; }
    .project-name { margin: 0; color: #171a21; font-size: 24px; line-height: 1.1; }
    .project-path { overflow-wrap: anywhere; color: #707686; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    .progress-wrap { display: grid; gap: 6px; max-width: 520px; }
    .progress-row { display: flex; justify-content: space-between; color: #666d7c; font-size: 12px; }
    .progress-track { height: 8px; overflow: hidden; border-radius: 999px; background: #e5e8f0; }
    .progress-fill { height: 100%; width: var(--progress, 0%); border-radius: inherit; background: linear-gradient(90deg, #5b5fc7, #2da879); }
    .insights { display: grid; gap: 10px; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(76px, 1fr)); gap: 8px; }
    .metric { border: 1px solid #e0e4ee; border-radius: 8px; background: #fff; padding: 9px 10px; }
    .metric strong { display: block; color: #171a21; font-size: 18px; line-height: 1.1; }
    .metric span { color: #727988; font-size: 11px; }
    .health-card { display: grid; gap: 9px; border: 1px solid #e0e4ee; border-radius: 8px; background: #f8f9fc; padding: 11px; }
    .health-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #667085; font-size: 12px; }
    .health-badge { border: 1px solid #d7deea; border-radius: 999px; background: #fff; padding: 4px 8px; color: #293241; font-weight: 650; }
    .distribution { display: flex; height: 9px; overflow: hidden; border-radius: 999px; background: #e5e8f0; }
    .distribution span { width: var(--width, 0%); background: var(--status-color, #8b93a4); }
    .focus-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .focus-card { min-width: 0; border: 1px solid #e0e4ee; border-radius: 8px; background: #fff; padding: 10px; }
    .focus-card span { display: block; color: #737b8d; font-size: 11px; }
    .focus-card strong { display: block; overflow: hidden; margin-top: 4px; color: #202532; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .viewbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; align-items: center; padding: 12px 18px; border-bottom: 1px solid #e5e8f0; background: #fff; }
    .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .filters label { display: flex; grid: none; align-items: center; gap: 6px; color: #667085; }
    .filters input[type="checkbox"] { width: auto; }
    .search { max-width: 360px; }
    .segmented { display: inline-flex; overflow: hidden; border: 1px solid #dfe3ec; border-radius: 8px; background: #f8f9fc; }
    .segmented button { border: 0; border-radius: 0; background: transparent; padding: 7px 10px; color: #667085; box-shadow: none; }
    .segmented button.active { background: #fff; color: #1f2430; box-shadow: 0 1px 2px #11182712; }
    main { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 410px); gap: 16px; padding: 16px 18px 18px; }
    .work-surface { min-width: 0; }
    .board { min-width: 0; display: grid; grid-template-columns: repeat(5, minmax(238px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
    .column { min-height: 62vh; border: 1px solid #e0e4ee; border-radius: 8px; background: #f8f9fc; }
    .column h2 { display: flex; justify-content: space-between; align-items: center; margin: 0; padding: 11px 12px; border-bottom: 1px solid #e2e6ef; border-radius: 8px 8px 0 0; background: color-mix(in srgb, #f8f9fc 92%, transparent); color: #626a7b; font-size: 12px; letter-spacing: 0; }
    .column-heading { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .status-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--status-color, #8b93a4); box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-color, #8b93a4) 14%, transparent); }
    .column-count { min-width: 22px; border-radius: 999px; background: #e9edf5; color: #374151; text-align: center; font-weight: 700; }
    .cards { display: grid; gap: 8px; padding: 8px; }
    .empty-column { border: 1px dashed #d6dbe7; border-radius: 8px; padding: 18px 10px; color: #8a91a1; font-size: 12px; text-align: center; }
    .card { position: relative; display: grid; gap: 8px; width: 100%; border: 1px solid #dfe4ee; border-radius: 8px; background: #fff; padding: 10px; text-align: left; box-shadow: 0 1px 1px #1118270a; }
    .card::before { content: ""; position: absolute; inset: 10px auto 10px 0; width: 3px; border-radius: 0 999px 999px 0; background: var(--status-color, #8b93a4); }
    .card:hover, .card.selected { border-color: #c9cfdd; background: #fff; box-shadow: 0 10px 26px #1d243314; }
    .card strong { display: block; padding-left: 2px; color: #5d6576; font-size: 11px; }
    .card-title { display: block; color: #202532; font-size: 13px; font-weight: 650; line-height: 1.35; }
    .card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .detail { position: sticky; top: 70px; align-self: start; border: 1px solid #dfe4ee; border-radius: 8px; background: #fff; padding: 14px; min-height: 260px; box-shadow: 0 8px 30px #1d24330d; }
    .detail h2 { margin: 0 0 10px; font-size: 17px; line-height: 1.25; }
    .detail-empty { display: grid; place-items: center; min-height: 220px; border: 1px dashed #d7dce8; border-radius: 8px; color: #7d8494; text-align: center; }
    form { display: grid; gap: 10px; }
    label { display: grid; gap: 5px; color: #667085; font-size: 12px; }
    input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid #d8dce6; border-radius: 8px; background: #fff; color: #202532; padding: 8px 10px; }
    textarea { min-height: 86px; resize: vertical; }
    .meta { color: #667085; font-size: 12px; }
    .comments { display: grid; gap: 8px; margin-top: 12px; }
    .comment { border: 1px solid #e0e5ef; border-left: 3px solid #7a7ee2; border-radius: 7px; background: #f8f9fc; padding: 8px 9px; font-size: 12px; white-space: pre-wrap; }
    .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .list-view { overflow: hidden; border: 1px solid #e0e4ee; border-radius: 8px; background: #fff; }
    .list-view table { width: 100%; border-collapse: collapse; }
    .list-view th, .list-view td { border-bottom: 1px solid #eef1f6; padding: 10px 12px; text-align: left; vertical-align: top; }
    .list-view th { color: #737b8d; font-size: 11px; font-weight: 650; text-transform: uppercase; }
    .list-view tr { cursor: pointer; }
    .list-view tr:hover, .list-view tr.selected { background: #f8f9fc; }
    .list-title { display: grid; gap: 3px; }
    .list-title strong { color: #202532; font-size: 13px; }
    .list-title span { color: #737b8d; font-size: 12px; }
    .status-pill, .project-badge { justify-self: start; border: 1px solid #d7deea; border-radius: 999px; background: #f7f9fc; padding: 3px 8px; color: #536176; font-size: 12px; line-height: 1.2; }
    .status-todo { --status-color: #7b8797; }
    .status-in_progress { --status-color: #d18b00; }
    .status-in_review { --status-color: #7c5cc4; }
    .status-done { --status-color: #17805d; }
    .status-blocked { --status-color: #c2413d; }
    button { border-color: var(--border); background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 560; }
    button:hover { border-color: #c8cfda; background: #fbfcfe; }
    .app-shell { background: var(--bg); }
    .rail { border-color: var(--rail-border); background: var(--rail); color: var(--rail-ink); }
    .brand h1 { color: var(--rail-ink); font-size: 15px; font-weight: 700; }
    .brand span, .project-nav-title, .project-tab span { color: #99a2b3; }
    .rail button { border-color: #2b3240; background: #171c25; color: #e8edf6; }
    .rail button:hover { background: #202735; border-color: #394253; }
    .rail .primary, .primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .rail .primary:hover, .primary:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
    .rail-stat { border-color: #27303e; background: var(--rail-raised); }
    .rail-stat strong { color: #fff; font-size: 20px; font-weight: 720; }
    .rail-stat span { color: #99a2b3; font-size: 11px; font-weight: 560; }
    .project-tab { color: #e8edf6; }
    .project-tab:hover { background: #171c25; }
    .project-tab.selected { border-color: #333b4a; background: #1e2530; box-shadow: inset 3px 0 0 var(--accent); }
    .project-tab strong { font-size: 13px; font-weight: 650; }
    .workspace { background: var(--bg); }
    header { border-color: var(--border-soft); background: color-mix(in srgb, var(--surface) 88%, transparent); }
    .breadcrumb { color: var(--muted); font-size: 11px; font-weight: 600; }
    .header-title { color: var(--ink); font-size: 20px; font-weight: 700; }
    .overview, .viewbar { border-color: var(--border-soft); background: var(--surface); }
    .project-kicker { color: var(--muted); font-size: 11px; font-weight: 660; text-transform: uppercase; }
    .project-name { color: var(--ink); font-size: 30px; font-weight: 760; letter-spacing: 0; }
    .project-path { color: var(--muted); }
    .progress-row { color: var(--muted); font-weight: 560; }
    .progress-track, .distribution { background: #e8edf5; }
    .progress-fill { background: linear-gradient(90deg, var(--accent), var(--success)); }
    .metric, .health-card, .focus-card, .detail, .list-view { border-color: var(--border-soft); background: var(--surface); box-shadow: 0 1px 2px #11182708; }
    .metric strong { color: var(--ink); font-size: 21px; font-weight: 730; }
    .metric span, .focus-card span, .health-row { color: var(--muted); font-weight: 560; }
    .health-card { background: var(--surface-subtle); }
    .health-badge { border-color: #cfd6e3; background: var(--surface); color: var(--ink); }
    .viewbar { background: #fbfcfe; }
    input, select, textarea { border-color: var(--border); background: var(--surface); color: var(--ink); }
    input:focus, select:focus, textarea:focus { border-color: color-mix(in srgb, var(--accent) 70%, var(--border)); outline: 3px solid color-mix(in srgb, var(--accent) 16%, transparent); }
    .segmented { border-color: var(--border); background: #eef2f7; }
    .segmented button.active { background: var(--surface); color: var(--ink); }
    .column { border-color: var(--border-soft); background: #f8fafc; }
    .column h2 { border-color: var(--border-soft); background: color-mix(in srgb, #f8fafc 94%, transparent); color: var(--muted); font-weight: 680; }
    .column-count { background: #e9eef6; color: #414b5b; }
    .card { border-color: #e2e7f0; background: var(--surface); box-shadow: 0 1px 2px #11182708; }
    .card:hover, .card.selected { border-color: #cfd6e3; box-shadow: var(--shadow); }
    .card strong { color: var(--muted); font-weight: 660; }
    .card-title, .list-title strong, .focus-card strong { color: var(--ink); font-weight: 670; }
    .detail { box-shadow: var(--shadow); }
    .comment { border-color: var(--border-soft); background: var(--surface-subtle); }
    .status-pill, .project-badge { border-color: var(--border); background: #f6f8fb; color: #4f5a6b; font-weight: 560; }
    .status-todo { --status-color: #7f8794; }
    .status-in_progress { --status-color: var(--warning); }
    .status-in_review { --status-color: var(--review); }
    .status-done { --status-color: var(--success); }
    .status-blocked { --status-color: var(--danger); }
    @media (max-width: 1180px) { .app-shell { grid-template-columns: 1fr; } .rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid #e0e3eb; } .project-nav { grid-auto-flow: column; grid-auto-columns: minmax(180px, 1fr); overflow-x: auto; } .project-nav-title { display: none; } .workspace { min-height: 0; } .metric-grid { grid-template-columns: repeat(4, minmax(72px, 1fr)); } }
    @media (max-width: 980px) { header, .overview, .viewbar { grid-template-columns: 1fr; } main { grid-template-columns: 1fr; } .board { grid-template-columns: repeat(5, 240px); } .detail { position: static; } .focus-grid { grid-template-columns: 1fr; } }
    @media (prefers-color-scheme: dark) {
      :root { background: #0f1117; color: #eef1f7; --bg: #0f1117; --surface: #161a23; --surface-subtle: #121720; --border: #303746; --border-soft: #282f3d; --ink: #f4f6fb; --muted: #a0a8b8; --rail: #0c0f14; --rail-raised: #161b24; --rail-border: #252b38; --accent: #7384ff; --accent-hover: #6374ef; --shadow: 0 18px 48px #0000003d; }
      body { background: var(--bg); }
      .rail, header, .overview, .viewbar, .detail { border-color: var(--border-soft); background: var(--surface); color: #eef1f7; }
      .rail { background: var(--rail); border-color: var(--rail-border); }
      .header-title, .project-name, .metric strong, .card-title, .rail-stat strong, .focus-card strong, .list-title strong { color: #f6f7fb; }
      .breadcrumb, .project-kicker, .project-path, label, .meta, .card strong, .metric span, .project-tab span { color: var(--muted); }
      .rail button, button { border-color: var(--border); background: #1a202b; color: #eef1f7; }
    .rail button:hover, button:hover { background: #222a38; border-color: #3a4355; }
      .rail-stat, .metric, .health-card, .focus-card, .list-view, .card, .comment, .segmented button.active, .project-tab.selected { border-color: var(--border); background: #1a202b; color: #eef1f7; }
      .overview, .viewbar, .column { border-color: var(--border-soft); background: var(--surface-subtle); }
      header { background: color-mix(in srgb, var(--surface) 88%, transparent); }
      .column h2 { border-color: var(--border-soft); background: color-mix(in srgb, var(--surface-subtle) 94%, transparent); color: #b7becc; }
      .column-count, .status-pill, .project-badge { border-color: var(--border); background: #202735; color: #cbd2df; }
      .segmented { border-color: var(--border); background: #111721; }
      .card:hover, .card.selected, .project-tab:hover, .list-view tr:hover, .list-view tr.selected { background: #222a38; }
      .progress-track, .distribution, .empty-column, .detail-empty { border-color: var(--border); background: #111721; }
      .list-view th, .list-view td { border-color: var(--border-soft); }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="rail">
      <div class="brand">
        <div>
          <h1>Project Board</h1>
          <span>Your Master workspace</span>
        </div>
        <button id="refresh" title="Refresh">Refresh</button>
      </div>
      <div class="rail-actions">
        <button id="create-project">Project</button>
        <button class="primary" id="create-work-item">Issue</button>
      </div>
      <div class="rail-summary" id="rail-summary"></div>
      <nav class="project-nav" id="projects"></nav>
    </aside>
    <section class="workspace">
      <header>
        <div>
          <div class="breadcrumb" id="breadcrumb">Projects / Board</div>
          <div class="header-title" id="header-title">Project Board</div>
        </div>
        <div class="header-actions">
          <button id="clear-filters">Clear filters</button>
          <button class="primary" id="create-work-item-top">New work item</button>
        </div>
      </header>
      <section class="overview" id="overview"></section>
      <section class="viewbar">
        <div class="filters">
          <input class="search" id="search" type="search" placeholder="Search title, identifier, goal, commit prefix">
          <label><input id="hide-done" type="checkbox"> Hide done</label>
        </div>
        <div class="segmented" aria-label="View mode">
          <button class="active" type="button" data-view="board">Board</button>
          <button type="button" data-view="list">List</button>
          <button type="button" disabled>Timeline</button>
        </div>
      </section>
      <main>
        <section class="work-surface" id="work-surface"></section>
        <aside class="detail" id="detail"><div class="detail-empty">Select a work item.</div></aside>
      </main>
    </section>
  </div>
  <script>
    const statuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];
    const statusLabels = {
      todo: 'Todo',
      in_progress: 'In progress',
      in_review: 'In review',
      done: 'Done',
      blocked: 'Blocked',
    };
    const lifecycleLabels = {
      blocked: 'Blocked',
      completed: 'Completed',
      integrating: 'Integrating',
      planning: 'Planning',
      queued: 'Queued',
      reviewing: 'Reviewing',
      validating: 'Validating',
      working: 'Working',
    };
    const worktreeStateLabels = {
      active: 'Worktree active',
      none: 'No worktree',
      preserved: 'Worktree preserved',
      removed: 'Worktree cleaned',
    };
    const activeStatuses = new Set(['todo', 'in_progress', 'in_review']);
    let snapshot = { projects: [], workItems: [], comments: [], runs: [] };
    let selectedProjectId = null;
    let selectedId = null;
    let detailMode = 'empty';
    let filters = { query: '', hideDone: false };
    let viewMode = 'board';

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

    function visibleProjectWorkItems() {
      const query = filters.query.trim().toLowerCase();
      return projectWorkItems().filter((item) => {
        if (filters.hideDone && item.status === 'done') {
          return false;
        }
        if (!query) {
          return true;
        }
        return [
          item.identifier,
          item.title,
          item.goal,
          item.commitPrefix,
          ...(item.acceptanceCriteria ?? []),
        ].filter(Boolean).join(' ').toLowerCase().includes(query);
      });
    }

    function selectedProjectMetrics() {
      const items = projectWorkItems();
      const done = items.filter(item => item.status === 'done').length;
      const active = items.filter(item => activeStatuses.has(item.status)).length;
      const blocked = items.filter(item => item.status === 'blocked').length;
      const progress = items.length > 0 ? Math.round((done / items.length) * 100) : 0;
      return { active, blocked, done, progress, total: items.length };
    }

    function statusCount(status) {
      return projectWorkItems().filter(item => item.status === status).length;
    }

    function firstByStatus(status) {
      return projectWorkItems().find(item => item.status === status) ?? null;
    }

    function projectHealthLabel(metrics) {
      if (metrics.blocked > 0) {
        return 'Needs attention';
      }
      if (metrics.active > 0) {
        return 'In motion';
      }
      if (metrics.total > 0 && metrics.done === metrics.total) {
        return 'Complete';
      }
      return 'Ready';
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

    async function startWorkItem(id) {
      const response = await fetch('/project-board/api/work-items/' + encodeURIComponent(id) + '/start', {
        method: 'POST',
      });
      const text = await response.text();
      let result = {};
      try {
        result = text ? JSON.parse(text) : {};
      }
      catch {
        result = { message: text };
      }
      if (!response.ok || !result.started) {
        alert(result.message ?? 'Work item did not start.');
      }
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
      const railSummary = document.getElementById('rail-summary');
      const title = document.getElementById('header-title');
      const breadcrumb = document.getElementById('breadcrumb');
      const overview = document.getElementById('overview');
      const project = selectedProject();
      const totalIssues = snapshot.workItems.length;
      const blockedIssues = snapshot.workItems.filter(item => item.status === 'blocked').length;
      railSummary.innerHTML = '<div class="rail-stat"><strong>' + snapshot.projects.length + '</strong><span>Projects</span></div><div class="rail-stat"><strong>' + totalIssues + '</strong><span>Issues</span></div>';
      if (!snapshot.projects.length) {
        title.textContent = 'No project registered';
        breadcrumb.textContent = 'Projects / Empty';
        overview.innerHTML = '<div class="project-hero"><div class="project-kicker">Local workspace</div><h2 class="project-name">Create a project to start planning</h2><div class="project-path">Use the Project button on the left rail.</div></div>';
        el.innerHTML = '<div class="project-nav-title"><span>Projects</span><span>0</span></div><button class="project-tab selected" type="button"><strong>No projects</strong><span>Register a local folder</span></button>';
        return;
      }

      const metrics = selectedProjectMetrics();
      const health = projectHealthLabel(metrics);
      const blockedItem = firstByStatus('blocked');
      const nextItem = firstByStatus('in_progress') ?? firstByStatus('todo') ?? firstByStatus('in_review');
      title.textContent = project?.name ? project.name + ' · ' + project.issuePrefix : 'Project Board';
      breadcrumb.textContent = 'Projects / ' + (project?.issuePrefix ?? 'Board');
      overview.innerHTML = '<div class="project-hero">'
        + '<div class="project-kicker">' + (project?.gitEnabled ? 'Git-backed project' : 'Local project') + '</div>'
        + '<h2 class="project-name">' + escapeHtml(project?.name) + '</h2>'
        + '<div class="project-path">' + escapeHtml(project?.rootPath) + '</div>'
        + '<div class="progress-wrap">'
        + '<div class="progress-row"><span>Completion</span><strong>' + metrics.progress + '%</strong></div>'
        + '<div class="progress-track"><div class="progress-fill" style="--progress:' + metrics.progress + '%"></div></div>'
        + '</div>'
        + '</div>'
        + '<div class="insights">'
        + '<div class="metric-grid">'
        + '<div class="metric"><strong>' + metrics.total + '</strong><span>Total</span></div>'
        + '<div class="metric"><strong>' + metrics.active + '</strong><span>Active</span></div>'
        + '<div class="metric"><strong>' + metrics.done + '</strong><span>Done</span></div>'
        + '<div class="metric"><strong>' + metrics.blocked + '</strong><span>Blocked</span></div>'
        + '</div>'
        + '<div class="health-card">'
        + '<div class="health-row"><span>Project health</span><strong class="health-badge">' + escapeHtml(health) + '</strong></div>'
        + '<div class="distribution">'
        + statuses.map(status => '<span class="status-' + escapeHtml(status) + '" title="' + escapeHtml(statusLabels[status] ?? status) + '" style="--width:' + (metrics.total > 0 ? Math.round((statusCount(status) / metrics.total) * 100) : 0) + '%"></span>').join('')
        + '</div>'
        + '<div class="focus-grid">'
        + '<div class="focus-card"><span>Focus</span><strong>' + escapeHtml(blockedItem ? blockedItem.identifier + ' · ' + blockedItem.title : 'No blockers') + '</strong></div>'
        + '<div class="focus-card"><span>Next up</span><strong>' + escapeHtml(nextItem ? nextItem.identifier + ' · ' + nextItem.title : 'No active issue') + '</strong></div>'
        + '</div>'
        + '</div>'
        + '</div>';
      el.innerHTML = '<div class="project-nav-title"><span>Projects</span><span>' + snapshot.projects.length + '</span></div>'
        + snapshot.projects.map(project =>
          '<div class="project-tab-row">'
          + '<button class="project-tab' + (selectedProject()?.id === project.id ? ' selected' : '') + '" type="button" data-project-select="' + escapeHtml(project.id) + '">'
          + '<strong>' + escapeHtml(project.name) + ' · ' + escapeHtml(project.issuePrefix) + '</strong>'
          + '<span>' + escapeHtml(project.rootPath) + '</span>'
          + '</button>'
          + '<button class="project-delete" type="button" title="Delete project" data-project-delete="' + escapeHtml(project.id) + '">×</button>'
          + '</div>'
        ).join('');
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
        el.innerHTML = '<div class="detail-empty"><div><strong>No issue selected</strong><br><span>Pick a card to inspect comments, branches, and run output.</span></div></div>';
        return;
      }
      const comments = snapshot.comments.filter(comment => comment.workItemId === item.id);
      const run = snapshot.runs.filter(candidate => candidate.workItemId === item.id).at(-1);
      const subtaskProgress = run?.subtaskProgress ?? [];
      const runDetails = run
        ? '<div class="comment"><strong>Run · ' + escapeHtml(lifecycleLabels[run.lifecycleStatus] ?? run.status) + '</strong><br>'
          + [
              run.planSummary ? 'Plan · ' + escapeHtml(run.planSummary) : '',
              run.verificationCommands?.length ? 'Verifier commands · ' + escapeHtml(run.verificationCommands.join(', ')) : '',
              run.worktreeState && run.worktreeState !== 'none' ? escapeHtml(worktreeStateLabels[run.worktreeState] ?? run.worktreeState) : '',
              run.changedFiles?.length ? 'Changed files · ' + escapeHtml(run.changedFiles.join(', ')) : '',
            ].filter(Boolean).join('<br>')
          + (subtaskProgress.length ? '<br>Subtasks<br>' + subtaskProgress.map(task => '- [' + escapeHtml(task.status) + '] ' + escapeHtml(task.title) + (task.evidence ? ': ' + escapeHtml(task.evidence) : '')).join('<br>') : '')
          + '</div>'
        : '';
      el.innerHTML = '<h2>' + escapeHtml(item.identifier) + '</h2>'
        + '<div class="card-meta"><span class="status-pill status-' + escapeHtml(item.status) + '">' + escapeHtml(statusLabels[item.status] ?? item.status) + '</span></div>'
        + '<div class="meta">' + escapeHtml(item.title) + '</div>'
        + (item.commitPrefix ? '<div class="meta">Commit prefix · ' + escapeHtml(item.commitPrefix) + '</div>' : '')
        + (run?.branchName ? '<div class="meta">Branch · ' + escapeHtml(run.branchName) + '</div>' : '')
        + (run?.worktreePath ? '<div class="meta">Worktree · ' + escapeHtml(run.worktreePath) + '</div>' : '')
        + '<p>' + escapeHtml(item.goal) + '</p>'
        + '<div class="actions">'
        + '<button data-action="edit">Edit</button>'
        + (item.status === 'todo' ? '<button data-action="start">Start</button>' : '')
        + '<button data-action="delete">Delete</button>'
        + '</div>'
        + '<div class="comments">' + runDetails + comments.map(comment => '<div class="comment"><strong>' + escapeHtml(comment.actorType) + ' · ' + escapeHtml(comment.kind) + '</strong><br>' + escapeHtml(comment.content) + '</div>').join('') + '</div>';
      el.querySelector('[data-action="edit"]').onclick = () => {
        detailMode = 'edit';
        renderWorkItemForm(item);
      };
      const startButton = el.querySelector('[data-action="start"]');
      if (startButton)
        startButton.onclick = () => startWorkItem(item.id);
      el.querySelector('[data-action="delete"]').onclick = () => {
        if (confirm(item.identifier + ' 일감을 삭제할까요?')) {
          void deleteWorkItem(item.id);
        }
      };
    }

    function renderBoardView(visibleItems) {
      const surface = document.getElementById('work-surface');
      surface.innerHTML = '<section class="board" id="board">'
        + statuses.map((status) => {
          const items = visibleItems.filter(item => item.status === status);
          return '<section class="column status-' + escapeHtml(status) + '"><h2><span class="column-heading"><span class="status-dot"></span><span>' + escapeHtml(statusLabels[status] ?? status) + '</span></span><span class="column-count">' + items.length + '</span></h2><div class="cards">'
            + (items.length > 0
              ? items.map(item => '<button class="card status-' + escapeHtml(item.status) + (selectedId === item.id ? ' selected' : '') + '" data-id="' + escapeHtml(item.id) + '"><strong>' + escapeHtml(item.identifier) + '</strong><span class="card-title">' + escapeHtml(item.title) + '</span><span class="card-meta"><span class="status-pill">' + escapeHtml(statusLabels[item.status] ?? item.status) + '</span>' + (item.commitPrefix ? '<span class="status-pill">' + escapeHtml(item.commitPrefix) + '</span>' : '') + '</span></button>').join('')
              : '<div class="empty-column">No issues</div>')
            + '</div></section>';
        }).join('')
        + '</section>';
      surface.querySelectorAll('[data-id]').forEach(node => node.onclick = () => {
        selectedId = node.dataset.id;
        detailMode = 'view';
        renderBoard();
      });
    }

    function renderListView(items) {
      const surface = document.getElementById('work-surface');
      surface.innerHTML = '<section class="list-view"><table><thead><tr><th>Issue</th><th>Status</th><th>Commit</th></tr></thead><tbody>'
        + (items.length > 0
          ? items.map(item => '<tr data-id="' + escapeHtml(item.id) + '" class="' + (selectedId === item.id ? 'selected' : '') + '"><td><div class="list-title"><strong>' + escapeHtml(item.identifier) + ' · ' + escapeHtml(item.title) + '</strong><span>' + escapeHtml(item.goal) + '</span></div></td><td><span class="status-pill status-' + escapeHtml(item.status) + '">' + escapeHtml(statusLabels[item.status] ?? item.status) + '</span></td><td>' + escapeHtml(item.commitPrefix ?? '') + '</td></tr>').join('')
          : '<tr><td colspan="3"><div class="empty-column">No issues match the current filters</div></td></tr>')
        + '</tbody></table></section>';
      surface.querySelectorAll('[data-id]').forEach(node => node.onclick = () => {
        selectedId = node.dataset.id;
        detailMode = 'view';
        renderBoard();
      });
    }

    function renderBoard() {
      const visibleItems = visibleProjectWorkItems();
      if (viewMode === 'list') {
        renderListView(visibleItems);
      }
      else {
        renderBoardView(visibleItems);
      }
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
    document.getElementById('clear-filters').onclick = () => {
      filters = { query: '', hideDone: false };
      document.getElementById('search').value = '';
      document.getElementById('hide-done').checked = false;
      renderBoard();
    };
    document.getElementById('search').oninput = (event) => {
      filters.query = event.target.value;
      renderBoard();
    };
    document.getElementById('hide-done').onchange = (event) => {
      filters.hideDone = event.target.checked;
      renderBoard();
    };
    document.querySelectorAll('[data-view]').forEach(node => {
      node.onclick = () => {
        viewMode = node.dataset.view;
        document.querySelectorAll('[data-view]').forEach(candidate => candidate.classList.toggle('active', candidate.dataset.view === viewMode));
        renderBoard();
      };
    });
    document.getElementById('create-project').onclick = () => {
      selectedId = null;
      detailMode = 'create-project';
      renderDetail();
    };
    function showCreateWorkItemForm() {
      selectedId = null;
      detailMode = 'create';
      renderDetail();
    }
    document.getElementById('create-work-item').onclick = showCreateWorkItemForm;
    document.getElementById('create-work-item-top').onclick = showCreateWorkItemForm;
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
  store: Pick<ProjectManagementStore, 'createWorkItem' | 'deleteProject' | 'deleteWorkItem' | 'getSnapshot' | 'registerProject' | 'subscribeSnapshot' | 'updateWorkItem'> & {
    startWorkItem: (payload: StartProjectWorkItemPayload) => Promise<StartProjectWorkItemResult> | StartProjectWorkItemResult
  }
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

  app.post('/project-board/api/work-items/:id/start', eventHandler(async (event) => {
    const id = event.context.params?.id
    if (!id)
      return new Response('Bad Request', { status: 400 })

    return options.store.startWorkItem({ workItemId: id })
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
