<template>
  <div
    :class="[
      'h-dvh w-full grid grid-cols-[272px_minmax(0,1fr)] overflow-hidden',
      'bg-neutral-100 dark:bg-neutral-950',
    ]"
    role="status"
    aria-live="polite"
  >
    <aside :class="['grid content-start gap-3 border-r border-neutral-200 bg-neutral-950 p-3 dark:border-neutral-800']">
      <div :class="['h-10 animate-pulse rounded-lg bg-neutral-800']" />
      <div :class="['grid grid-cols-2 gap-2']">
        <div :class="['h-16 animate-pulse rounded-lg bg-neutral-900']" />
        <div :class="['h-16 animate-pulse rounded-lg bg-neutral-900']" />
      </div>
      <div :class="['h-9 animate-pulse rounded-lg bg-neutral-800']" />
      <div
        v-for="index in 6"
        :key="index"
        :class="['h-9 animate-pulse rounded-lg bg-neutral-900']"
      />
    </aside>
    <main :class="['grid min-w-0 grid-rows-[72px_176px_minmax(0,1fr)]']">
      <div :class="['border-b border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950']">
        <div :class="['h-5 w-56 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800']" />
      </div>
      <div :class="['grid grid-cols-2 gap-4 border-b border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950']">
        <div :class="['grid content-start gap-3']">
          <div :class="['h-4 w-32 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800']" />
          <div :class="['h-4 w-3/4 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800']" />
          <div :class="['h-2 w-1/2 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800']" />
        </div>
        <div :class="['grid grid-cols-4 gap-2']">
          <div
            v-for="index in 4"
            :key="index"
            :class="['h-16 animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-900']"
          />
        </div>
      </div>
      <div :class="['flex gap-3 overflow-hidden p-4']">
        <section
          v-for="column in 3"
          :key="column"
          :class="['w-80 shrink-0 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900']"
        >
          <div :class="['mb-2 h-8 animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-800']" />
          <div
            v-for="card in 3"
            :key="card"
            :class="['mb-2 h-28 animate-pulse rounded-lg bg-white dark:bg-neutral-950']"
          />
        </section>
      </div>
    </main>
  </div>
</template>
