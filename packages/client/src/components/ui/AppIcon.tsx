import { useEffect, useState } from "react";

interface AppIconProps {
  name: string;
  src?: string | null;
  imgStyle?: React.CSSProperties;
}

export function AppIcon({ name, src, imgStyle }: AppIconProps) {
  const [errored, setErrored] = useState(false);
  const normalizedSrc = typeof src === "string" ? src.trim() : "";
  const fallback = name.trim().charAt(0).toUpperCase();

  useEffect(() => {
    setErrored(false);
  }, [normalizedSrc]);

  if (!normalizedSrc || errored) return fallback;

  return (
    <img
      src={normalizedSrc}
      alt={name}
      style={imgStyle}
      onError={() => setErrored(true)}
    />
  );
}
