import initialProfile from './initial-question-profile.json';
import {validateQuestionProfileShape,type QuestionProfile} from '../../src/games/ionic-formula/shared/question-profile';
import {validateQuestionProfile} from '../../src/games/ionic-formula/server/question-generator';
const key='ionic-lite:question-profile';
export function readProfile():QuestionProfile {
  try {const saved=localStorage.getItem(key);if(saved)return validateQuestionProfileShape(JSON.parse(saved));}catch{}
  return structuredClone(initialProfile) as QuestionProfile;
}
export function saveProfile(profile:QuestionProfile) {
  const valid=validateQuestionProfileShape(profile);validateQuestionProfile(valid);
  localStorage.setItem(key,JSON.stringify(valid));
}
