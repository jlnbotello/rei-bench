const { createApp, ref, computed, onMounted } = Vue;

const App = {
    setup() {
        const data = ref(null);
        const loading = ref(true);
        const error = ref(null);
        const searchQuery = ref('');
        const activeModal = ref(null);
        const activeModelModal = ref(null);
        const activePlatformId = ref(null);

        const fetchData = async () => {
            try {
                const response = await fetch('data.json');
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const json = await response.json();
                
                json.tasks.sort((a, b) => a.id.localeCompare(b.id));
                data.value = json;

                if (json.platforms && json.platforms.length > 0) {
                    activePlatformId.value = json.platforms[0].id;
                }

            } catch (e) {
                console.error("Could not load data.json:", e);
                error.value = "Failed to load benchmark data. Ensure data.json exists.";
            } finally {
                loading.value = false;
            }
        };

        onMounted(() => {
            fetchData();
        });

        const activePlatform = computed(() => {
            if (!data.value || !data.value.platforms) return null;
            return data.value.platforms.find(p => p.id === activePlatformId.value) || null;
        });

        const filteredModels = computed(() => {
            if (!data.value || !data.value.models) return [];
            return data.value.models.filter(m => m.platformId === activePlatformId.value);
        });

        const filteredTasks = computed(() => {
            if (!data.value) return [];
            
            // Only return tasks that have at least one result for the active platform
            const validTasks = data.value.tasks.filter(task => {
                return filteredModels.value.some(model => task.results[model.id] !== undefined);
            });

            if (!searchQuery.value) return validTasks;
            
            const lowerQuery = searchQuery.value.toLowerCase();
            return validTasks.filter(task => 
                task.id.toLowerCase().includes(lowerQuery)
            );
        });

        const parseModelName = (idOrName) => {
            let name = idOrName.includes('::') ? idOrName.split('::')[1] : idOrName;
            let clean = name.replace(/_gguf$/i, '');
            clean = clean.replace(/-\d{5}-of-\d{5}$/i, '');
            
            let base = clean;
            let quant = null;

            // Check for custom "-to-" platform quantization format
            const toMatch = clean.match(/(.*?)-to-(.*)$/i);
            if (toMatch) {
                let tempBase = toMatch[1];
                let tempQuant = toMatch[2];
                // Strip common model details like MTP-BF16 before the "-to-" prefix if they exist
                tempBase = tempBase.replace(/-MTP-BF16$/i, '');
                base = tempBase;
                quant = tempQuant.replace(/_/g, '.');
            } else {
                // First check for verbose IQ quants (e.g., IQ2XXS-w2Q2K-AProjQ8...)
                const iqMatch = clean.match(/(.*?)-(IQ.*)$/i);
                if (iqMatch) {
                    base = iqMatch[1];
                    quant = iqMatch[2];
                } else {
                    // Check standard Q or UD-Q quants
                    const match = clean.match(/(.*?)-(UD-Q[A-Z0-9_]+|Q[A-Z0-9_]+)$/i);
                    if (match) {
                        base = match[1];
                        quant = match[2];
                    }
                }
            }
            
            // Normalize: replace underscores with dots (e.g. Qwen3_6 -> Qwen3.6)
            base = base.replace(/_/g, '.');
            // Capitalize first letter
            base = base.charAt(0).toUpperCase() + base.slice(1);
            // Insert space between name and version if missing (e.g. Qwen3.6 -> Qwen 3.6)
            base = base.replace(/^([a-zA-Z]+)(\d)/, '$1 $2');

            return {
                base: base,
                quant: quant
            };
        };

        const formatDuration = (ms) => {
            if (!ms) return 'N/A';
            const totalSeconds = Math.floor(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${minutes}m ${seconds}s`;
        };

        const getScoreClass = (rate) => {
            if (rate >= 0.8) return 'high';
            if (rate >= 0.5) return 'med';
            return 'low';
        };

        const openModal = (taskId, modelId, result, tag) => {
            const model = data.value && data.value.models ? data.value.models.find(m => m.id === modelId) : null;
            activeModal.value = { taskId, modelId, result, tag, model };
            document.body.style.overflow = 'hidden'; 
        };

        const closeModal = () => {
            activeModal.value = null;
            document.body.style.overflow = 'auto';
        };

        const openModelModal = (model) => {
            activeModelModal.value = model;
            document.body.style.overflow = 'hidden';
        };

        const closeModelModal = () => {
            activeModelModal.value = null;
            document.body.style.overflow = 'auto';
        };

        const highlightDiff = (diffText) => {
            if (!diffText) return '';
            return diffText.split('\n').map(line => {
                const safeLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                if (safeLine.startsWith('+') && !safeLine.startsWith('+++')) {
                    return `<span class="diff-add">${safeLine}</span>`;
                }
                if (safeLine.startsWith('-') && !safeLine.startsWith('---')) {
                    return `<span class="diff-sub">${safeLine}</span>`;
                }
                if (safeLine.startsWith('@@')) {
                    return `<span class="diff-info">${safeLine}</span>`;
                }
                return safeLine;
            }).join('\n');
        };

        const formatDate = (isoString) => {
            if (!isoString) return '';
            return new Date(isoString).toLocaleString();
        };

        return {
            data,
            loading,
            error,
            searchQuery,
            activePlatformId,
            activePlatform,
            filteredModels,
            filteredTasks,
            activeModal,
            activeModelModal,
            parseModelName,
            formatDuration,
            getScoreClass,
            openModal,
            closeModal,
            openModelModal,
            closeModelModal,
            highlightDiff,
            formatDate
        };
    }
};

createApp(App).mount('#app');
