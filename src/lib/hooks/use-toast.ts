export interface ToastOptions {
  title: string;
  description: string;
  variant?: 'default' | 'destructive';
}

export const useToast = () => {
  const toast = (options: ToastOptions) => {
    console.log('Toast:', options);
  };

  return { toast };
};
