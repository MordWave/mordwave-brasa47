# Restaurant Demo — MordWave

Demo de aplicación web para restaurante, creada por **MordWave** para mostrar a futuros clientes.

## Contexto de MordWave

MordWave es un emprendimiento de diseño y desarrollo web enfocado en landing pages, sitios web informativos y demos de aplicaciones para mostrar a futuros clientes.

## Stack

- React
- Vite
- JavaScript
- CSS
- Git
- GitHub
- Vercel

No agregar backend, base de datos ni tecnologías adicionales si no son necesarias. Antes de agregar una tecnología nueva, explicar brevemente por qué hace falta.

## Forma de trabajar

Priorizar:

- Código simple y entendible
- Componentes reutilizables
- Diseño responsive
- Buena experiencia móvil
- Buen rendimiento
- Evitar sobreingeniería

## Deploy

React + Vite → GitHub → Vercel → dominio personalizado.

Los dominios de clientes deben quedar idealmente a nombre del cliente. MordWave puede ayudar con la compra, configuración DNS y conexión con Vercel.

## Identidad

Esta demo es para un cliente de tipo **restaurante**, por lo que debe usar identidad visual propia del rubro (no la identidad de MordWave, que es negro/blanco/morado, moderna y minimalista) — salvo indicación contraria.

## Estado del proyecto

Demo funcional de sistema de pedidos QR para un restaurante ficticio (**BRASA 47 — Burger · Pizza · Bar**), sin backend ni base de datos: usa localStorage para simular pedidos.

Flujo: Home inmersivo (hero + detección/ingreso de mesa) → menú → personalización de producto → carrito → confirmación → pantalla de éxito. Panel `/admin` simula la vista de cocina/mesero con estados Nuevo/Preparando/Listo/Entregado.

Precios en formato CLP (`$6.900`). No hay fotografías reales de comida (evitamos descargar assets de fuentes externas sin licencia clara); en su lugar se usan ilustraciones SVG propias a color.
