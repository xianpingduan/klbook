import { useEffect, useState } from 'react';

export function useTouchInput() {
  const [touch, setTouch] = useState(() => matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    const media = matchMedia('(pointer: coarse)');
    const update = () => setTouch(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return touch;
}
