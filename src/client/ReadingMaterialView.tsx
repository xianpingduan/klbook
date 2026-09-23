import type { ReadingMaterial } from '../shared/reading-materials.ts';
import type { FamilyApi } from './api.ts';
import { QuestionParts } from './QuestionParts.tsx';

export function ReadingMaterialView({ api, material }: { api: FamilyApi; material: ReadingMaterial }) {
  return <section className="reading-material" aria-label="共享阅读材料"><p className="eyebrow">共享阅读材料</p><h2>{material.title}</h2><QuestionParts api={api} parts={material.parts} reading /></section>;
}
