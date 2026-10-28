"""Bounded request-local image input. Images never enter event-bus scope or prompts."""
from __future__ import annotations
import base64
import binascii
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class ImageInput:
    media_type: str
    data: str

    def block(self):
        return {'type': 'image', 'source': {'type': 'base64', 'media_type': self.media_type, 'data': self.data}}


images: ContextVar[tuple[ImageInput, ...]] = ContextVar('herald_request_images', default=())
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 24 * 1024 * 1024
MAX_IMAGES = 8


def extract(messages):
    result, total = [], 0
    for message in messages:
        content = message.get('content')
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get('type') != 'image_url':
                continue
            value = part.get('image_url')
            url = value.get('url') if isinstance(value, dict) else value
            if not isinstance(url, str) or not url.startswith('data:image/'):
                raise ValueError('Image input requires an inline PNG, JPEG or WebP data URL')
            if len(url) > MAX_IMAGE_BYTES * 4 // 3 + 256:
                raise ValueError('Image input exceeds 8 MB')
            header, sep, encoded = url.partition(',')
            media = header.removeprefix('data:').removesuffix(';base64')
            if not sep or not header.endswith(';base64') or media not in ('image/png', 'image/jpeg', 'image/webp'):
                raise ValueError('Image input requires base64 PNG, JPEG or WebP data')
            try:
                decoded = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError('Invalid base64 image input') from None
            valid = (media == 'image/png' and decoded.startswith(b'\x89PNG\r\n\x1a\n') or
                     media == 'image/jpeg' and decoded.startswith(b'\xff\xd8\xff') or
                     media == 'image/webp' and decoded.startswith(b'RIFF') and decoded[8:12] == b'WEBP')
            if not valid or not decoded or len(decoded) > MAX_IMAGE_BYTES:
                raise ValueError('Invalid or oversized image input')
            total += len(decoded)
            result.append(ImageInput(media, encoded))
            if len(result) > MAX_IMAGES or total > MAX_TOTAL_BYTES:
                raise ValueError('Image request exceeds 8 images or 24 MB')
    return tuple(result)


@contextmanager
def image_context(messages):
    token = images.set(extract(messages))
    try:
        yield
    finally:
        images.reset(token)


def user_content(prompt):
    current = images.get()
    return ([{'type': 'text', 'text': prompt}] + [
        {'type': 'image_url', 'image_url': {'url': f'data:{image.media_type};base64,{image.data}'}}
        for image in current]) if current else prompt


def anthropic_content(prompt):
    current = images.get()
    return [{'type': 'text', 'text': prompt}, *[image.block() for image in current]] if current else prompt
