/**
 * CSS Modules declaration for the client bundle. tsdown's clientBundle preset
 * compiles `*.module.css` through lightningcss into a hashed class map; this
 * ambient declaration gives the compiler the import shape.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
