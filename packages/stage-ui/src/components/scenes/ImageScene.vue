<script setup lang="ts">
import type { StageComponentState } from './image-scene'

import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { resolveImageSceneState } from './image-scene'

// Static-image avatar renderer.
//
// Shows a single flat image (PNG/JPG/WebP) as the character and fakes "being
// alive" with purely procedural CSS motion: a slow breathing scale, a gentle
// horizontal sway, and a subtle vertical float. There is no rig behind the
// image, so this intentionally has no blink / lip-sync / expression support.
// The motion layers are nested so each transform animates independently and
// they compose instead of overwriting one another.

const props = withDefaults(defineProps<{
  modelSrc?: string
  paused?: boolean
  scale?: number
  xOffset?: number | string
  yOffset?: number | string
}>(), { paused: false, scale: 1 })

const componentState = defineModel<StageComponentState>('state', { default: 'pending' })

const imgRef = ref<HTMLImageElement | null>(null)

// Pause all idle motion when the stage is paused or the user prefers reduced
// motion (handled in CSS via the media query below as well).
const playState = computed(() => (props.paused ? 'paused' : 'running'))

// Normalize px-or-string offsets the same way the Live2D/VRM scenes accept them.
function toLength(value?: number | string) {
  if (value == null)
    return '0px'

  return typeof value === 'number' ? `${value}px` : value
}

const containerStyle = computed(() => ({
  transform: `translate(${toLength(props.xOffset)}, ${toLength(props.yOffset)}) scale(${props.scale})`,
}))

// Reconciles the reported state with the actual <img> readiness. Needed because
// the `load` event does not fire for an image that is already cached/decoded by
// the time the element mounts; reading `complete`/`naturalWidth` covers that
// case so the host's "Loading..." overlay does not get stuck (or flash) over an
// image that is, in fact, ready.
function syncState() {
  const el = imgRef.value
  componentState.value = resolveImageSceneState({
    hasSrc: Boolean(props.modelSrc),
    complete: el?.complete ?? false,
    naturalWidth: el?.naturalWidth ?? 0,
  })
}

function onImageLoad() {
  componentState.value = 'mounted'
}

function onImageError() {
  componentState.value = 'pending'
}

onMounted(syncState)

// On source change the element keeps the previous frame until the new one
// decodes, so re-check after the DOM applies the new src: a cached swap settles
// to 'mounted' immediately, otherwise we wait in 'loading' for `load`.
watch(() => props.modelSrc, async () => {
  componentState.value = props.modelSrc ? 'loading' : 'pending'
  await nextTick()
  syncState()
})
</script>

<template>
  <div
    :class="['relative h-full w-full', 'flex items-center justify-center', 'overflow-hidden']"
    :style="containerStyle"
  >
    <div
      v-if="modelSrc"
      class="image-scene-float"
      :style="{ animationPlayState: playState }"
      h-full max-h-full w-full flex items-center justify-center
    >
      <div
        class="image-scene-sway"
        :style="{ animationPlayState: playState }"
        h-full w-full flex items-center justify-center
      >
        <img
          ref="imgRef"
          :src="modelSrc"
          class="image-scene-breathe"
          :style="{ animationPlayState: playState }"
          alt="Character"
          draggable="false"
          h-full max-h-full max-w-full w-auto select-none object-contain
          @load="onImageLoad"
          @error="onImageError"
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
/* transform-origin sits at the bottom so breathing reads like the chest/torso
   lifting rather than the whole sprite zooming from its center. */
.image-scene-breathe {
  transform-origin: 50% 100%;
  animation: image-scene-breathe 3.6s ease-in-out infinite;
}

.image-scene-sway {
  transform-origin: 50% 100%;
  animation: image-scene-sway 6.2s ease-in-out infinite;
}

.image-scene-float {
  animation: image-scene-float 4.8s ease-in-out infinite;
}

@keyframes image-scene-breathe {
  0%, 100% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.03, 1.045);
  }
}

@keyframes image-scene-sway {
  0%, 100% {
    transform: translateX(-1.6%) rotate(-1.4deg);
  }
  50% {
    transform: translateX(1.6%) rotate(1.4deg);
  }
}

@keyframes image-scene-float {
  0%, 100% {
    transform: translateY(2%);
  }
  50% {
    transform: translateY(-2%);
  }
}

/* NOTICE:
   Intentionally NOT gating idle motion behind `prefers-reduced-motion`.
   Root cause: a previous version disabled all motion under that media query,
   so on machines with the OS "reduce motion" setting enabled the avatar looked
   completely frozen. The breathing/sway/float IS the core behavior of this
   image-avatar renderer (the only thing that makes a flat PNG feel alive), so
   it is treated as essential content rather than decorative motion.
   Removal condition: when an explicit per-avatar "idle motion" toggle exists in
   settings, route reduced-motion handling through that instead. */
</style>
