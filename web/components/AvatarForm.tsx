'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { removeAvatar, uploadAvatar, type AvatarState } from '@/app/cuenta/actions';
import { AVATAR_MAX_CHARS, AVATAR_SIZE } from '@/lib/avatar';
import LiveStatus from './LiveStatus';

/** Center-crops the picked image to a square and scales it to AVATAR_SIZE; WebP when the browser can, else JPEG. */
async function toSquareDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  // Safari without WebP encoding returns PNG for 'image/webp'; JPEG keeps that fallback small.
  const webp = canvas.toDataURL('image/webp', 0.85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * "Foto de perfil" on Mi cuenta: the current photo, a picker and a remove button. The photo is resized in the
 * browser (a 256px square is a few dozen KB) and validated again on the server.
 */
export default function AvatarForm({ src }: { src: string }) {
  const [state, formAction, saving] = useActionState(uploadAvatar, {} as AvatarState);
  const [removeState, removeAction, removing] = useActionState(removeAvatar, {} as AvatarState);
  const [preview, setPreview] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | undefined) => {
    setLocalError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setLocalError('Elige una imagen.');
      return;
    }
    try {
      const dataUrl = await toSquareDataUrl(file);
      if (dataUrl.length > AVATAR_MAX_CHARS) {
        setLocalError('La imagen es demasiado grande. Prueba con otra.');
        return;
      }
      setPreview(dataUrl);
      const form = new FormData();
      form.set('image', dataUrl);
      startTransition(() => formAction(form));
    } catch {
      setLocalError('No se pudo leer esa imagen. Prueba con una foto JPG o PNG.');
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  const error = localError ?? state.error ?? removeState.error;
  const shown = removeState.saved && (!state.saved || removeState.saved > state.saved) ? null : preview;
  const status = saving ? 'Guardando foto…' : removing ? 'Quitando foto…' : state.saved || removeState.saved ? 'Foto actualizada' : '';

  return (
    <div className="avatar-form">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL preview or the private avatar route */}
      <img src={shown ?? src} alt="Tu foto de perfil" width={96} height={96} className="avatar-preview" />
      <div className="avatar-actions">
        <label className="btn primary">
          Cambiar foto
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={saving}
            onChange={(event) => void onPick(event.target.files?.[0])}
          />
        </label>
        <form action={removeAction}>
          <button type="submit" className="btn ghost" disabled={removing || saving}>
            Quitar foto
          </button>
        </form>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <LiveStatus message={status} />
    </div>
  );
}
