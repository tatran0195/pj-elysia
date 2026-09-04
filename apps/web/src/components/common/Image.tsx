import { cn } from '@/lib/utils';

// The app's image element. Media is streamed through the web origin's /media route
// (see server/middleware.mjs) and every call site sizes its own box, so a plain
// `<img>` with lazy loading covers what the app needs — no optimizer, no build-time
// origin allowlist, and a blob: preview works like any other source.
//
// `fill` keeps the API the layouts are written against: the image covers its
// positioned parent instead of carrying intrinsic dimensions.

type ImgProps = Omit<React.ComponentPropsWithoutRef<'img'>, 'src' | 'alt' | 'width' | 'height'>;

export interface ImageProps extends ImgProps {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  /** Cover the nearest positioned ancestor instead of using intrinsic dimensions. */
  fill?: boolean;
  /** Load eagerly, for an image that is part of the first paint. */
  priority?: boolean;
  /** Accepted and ignored: nothing is optimized, so every source is served as-is. */
  unoptimized?: boolean;
  quality?: number;
}

export default function Image({
  fill,
  priority,
  unoptimized: _unoptimized,
  quality: _quality,
  className,
  style,
  loading,
  ...props
}: ImageProps) {
  return (
    <img
      {...props}
      loading={loading ?? (priority ? 'eager' : 'lazy')}
      decoding={priority ? 'sync' : 'async'}
      className={cn(fill && 'absolute inset-0 size-full', className)}
      style={fill ? { objectFit: 'cover', ...style } : style}
    />
  );
}

export { Image };
