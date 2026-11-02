import IconButton, { icons } from '../common/IconButton';

interface IconRemoveButtonProps {
  onClick: () => void;
  'aria-label': string;
  title?: string;
}

/** Remove a draft row with the same target and feedback as other icon actions. */
export default function IconRemoveButton({ onClick, 'aria-label': ariaLabel, title }: IconRemoveButtonProps) {
  return <IconButton onClick={onClick} label={ariaLabel} title={title} icon={icons.close} tone="danger" />;
}
