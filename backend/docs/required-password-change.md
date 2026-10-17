# Cambio obligatorio de contraseña (8D.2d-2c)

Cuando `users.must_change_password = true`, el usuario solo puede llamar a **dos** rutas:

| Ruta | Para qué |
|---|---|
| `GET /auth/me` | que el cliente sepa que debe cambiar la contraseña (`mustChangePassword`) |
| `POST /auth/change-password` | la única salida: al tener éxito pone `must_change_password = false`, sube `credentials_version` y devuelve una sesión nueva |

Cualquier otra ruta autenticada responde **`403 { message, errorCode: "PASSWORD_CHANGE_REQUIRED" }`**, para cualquier rol (SUPER_ADMIN incluido).

## Cómo se aplica
- En `JwtAuthGuard` (el único mecanismo con el que se autentican las rutas protegidas), **después** de que Passport autentica y `JwtStrategy`
  carga al usuario **desde PostgreSQL**. La señal nunca viene del JWT, del body, del query ni de cabeceras.
- **Denegar por defecto y fallar cerrado:** solo un `false` real deja pasar; `undefined`, `null` o cualquier otro valor se trata como "debe cambiarla".
- Las excepciones salen de **metadata** (`@AllowPasswordChangeRequired()`, leída solo del *handler*, nunca de la clase), no de comparar rutas
  como texto. El decorador solo omite esta comprobación: la autenticación y el resto de reglas siguen aplicándose.
- Como el guard va antes que `RolesGuard`, ningún rol lo esquiva.
- Una ruta nueva queda protegida sin hacer nada. `test/required-password-change.e2e-spec.ts` enumera todas las rutas de la aplicación y falla si
  aparece una ruta que no use `JwtAuthGuard` y no esté clasificada como pública, o si el decorador está en algo distinto de esas dos rutas.

## Prioridad cuando varias cosas aplican a la vez
1. **Autenticación** (token inválido/caducado, versión de credenciales antigua, usuario inactivo): `401`.
2. **Negocio suspendido** (solo ADMIN): `403 BUSINESS_INACTIVE`. Se lanza mientras se autentica, así que gana **también en `/auth/me` y
   `/auth/change-password`**: un ADMIN con contraseña temporal cuyo negocio está suspendido no puede cambiarla hasta que se reactive el negocio.
   (Las políticas de suspensión no cambian; SUPER_ADMIN no depende de ningún negocio.)
3. **`403 PASSWORD_CHANGE_REQUIRED`**.
4. La regla de rol de la ruta (`403` sin `errorCode`).

## Contratos
`mustChangePassword` (booleano real, leído de la fila) aparece en `user` de `POST /auth/login`, `GET /auth/me` y la respuesta de
`POST /auth/change-password`. No está en el JWT (formato sin cambios) ni se puede fijar desde el cliente.

## Frontend (pendiente)
El frontend actual no tiene pantalla de cambio obligatorio. Es aceptable **solo** porque todavía no existe ningún usuario con
`must_change_password = true` (la CLI de bootstrap crea el SUPER_ADMIN con `false`). **8D.2d-4 debe implementar esa interfaz antes de
aprovisionar ADMIN reales con contraseña temporal.** Hasta entonces un 403 `PASSWORD_CHANGE_REQUIRED` se vería como un error de permisos.
