const palettes = ['warm','cool','neutral','sage','iris'];
function validateAppearance(value) {
  if(!value || typeof value!=='object' || !['light','dark','system'].includes(value.theme) || !palettes.includes(value.light) || !palettes.includes(value.dark)) throw Error('Choose a valid mode and a palette for both light and dark.');
  return {theme:value.theme,light:value.light,dark:value.dark};
}
module.exports={validateAppearance};
