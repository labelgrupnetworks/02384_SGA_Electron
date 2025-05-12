// Script para publicar con token de GitHub cargado desde .env
require('dotenv').config();
const { execSync } = require('child_process');

console.log('Cargando variables de entorno desde .env...');

// Verificar si el token está disponible
if (!process.env.GITHUB_TOKEN) {
  console.error('Error: No se ha encontrado GITHUB_TOKEN en el archivo .env');
  process.exit(1);
}

console.log('Token de GitHub detectado correctamente');

try {
  // Ejecutar el comando de electron-forge publish con el token ya cargado en el entorno
  console.log('Ejecutando electron-forge publish...');
  execSync('npx electron-forge publish', { stdio: 'inherit' });
  console.log('Publicación completada con éxito');
} catch (error) {
  console.error('Error durante la publicación:', error.message);
  process.exit(1);
}