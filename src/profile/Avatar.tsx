export default function Avatar({
  name,
  src,
  large = false,
}: {
  name: string;
  src: string;
  large?: boolean;
}) {
  return (
    <span className={`avatar ${large ? 'large-avatar' : ''}`}>
      {src ? <img src={src} alt="Аватар" /> : name.slice(0, 1).toUpperCase() || 'П'}
    </span>
  );
}
