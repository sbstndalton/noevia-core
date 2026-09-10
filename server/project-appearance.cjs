const icons = require('./project-icons.json');
function projectAppearance(body) {
  const result = {};
  if (Object.hasOwn(body, 'icon')) {
    if (typeof body.icon !== 'string' || !Object.hasOwn(icons, body.icon)) throw new Error('Choose a supported project icon.');
    result.icon = body.icon;
  }
  if (Object.hasOwn(body, 'color')) {
    if (typeof body.color !== 'string' || (body.color !== 'default' && !/^#[0-9a-f]{6}$/i.test(body.color))) throw new Error('Project color must be default or a six-digit hex color.');
    result.color = body.color.toLowerCase();
  }
  return result;
}
module.exports = { projectAppearance };
