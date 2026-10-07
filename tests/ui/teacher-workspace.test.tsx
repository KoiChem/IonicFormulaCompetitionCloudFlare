import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TeacherManagement } from '../../app/teacher/TeacherManagement';
import { TeacherClient } from '../../app/teacher/TeacherClient';
it('separates permission, availability and difficulty actions into named regions',()=>{
 const html=renderToStaticMarkup(createElement(TeacherManagement));
 expect(html).toContain('許可教員の管理');expect(html).toContain('メイトマッチの作成');expect(html).toContain('出題の難易度');expect(html).toContain('難易度を調整');
 expect(html).toContain('aria-labelledby="teacher-access-title"');expect(html).toContain('aria-labelledby="mate-availability-title"');expect(html).toContain('aria-labelledby="difficulty-management-title"');
});
it('starts with the complete class form before granting access to admin settings',()=>{
 const html=renderToStaticMarkup(createElement(TeacherClient));
 expect(html).toContain('クラスルームを作る');expect(html).toContain('問題数');expect(html).not.toContain('難易度を調整');expect(html).not.toContain('teacher-email');
});
